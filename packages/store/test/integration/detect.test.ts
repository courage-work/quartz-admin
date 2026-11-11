import type oracledb from 'oracledb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OracleAdapter,
  TargetPoolManager,
  createTableSet,
  detectQuartz,
  listNodes,
  listTriggers,
  oracleDialect,
  queryDbNowMillis,
  type DetectedTableSet,
  type PoolTarget,
  type QuartzDetection,
} from '../../src/index.js';
import {
  QUARTZ_TABLES,
  QUARTZ_VERSION,
  initQuartzSchema,
  quartzTableName,
  startQuartzCluster,
  type OracleCredentials,
  type QuartzCluster,
  type QuartzSchemaOptions,
  TEST_DB,
} from '../support/index.js';

const ORACLE_PORT = 1521;
/** 권한 부족. Oracle 23은 ORA-41900(어떤 권한이 없는지 알려줌), 이전 버전은 ORA-01031 */
const PRIVILEGE_ERROR = expect.stringMatching(/^ORA-(01031|41900)$/) as unknown as string;

/**
 * 자동 감지 (B-12, TRD §5.5). 한 Oracle에 다음 스키마를 둔다.
 * - QUARTZ: 테스트베드 2노드 클러스터가 쓰는 `QRTZ_`(기본 prefix)와 SQL로 채운 `BATCH_`(사용자 지정 prefix,
 *   SCHED_NAME 2개, 불리언 `Y`/`N`), 필수 테이블이 빠진 `BROKEN_`
 * - LOWERQ: 따옴표 소문자 테이블(`qrtz_`)
 * - Q23: Oracle 23 BOOLEAN 스키마
 * - READER: QUARTZ 테이블에 SELECT 권한만 있는 계정
 * - NOLOCK: LOCKS의 UPDATE 권한만 없는 계정
 */
describe.skipIf(TEST_DB !== 'oracle')(
  `자동 감지 (Oracle Free 23, Quartz ${QUARTZ_VERSION})`,
  () => {
    let cluster: QuartzCluster;
    /** Oracle 전용 테스트다. 계정·권한 준비는 Oracle 픽스처를 직접 쓴다 */
    const oracle = () => cluster.db.oracle!;
    let pools: TargetPoolManager;
    let owner: OracleCredentials;
    let reader: OracleCredentials;
    let noLock: OracleCredentials;
    const batch: QuartzSchemaOptions = { prefix: 'BATCH_' };

    const target = (credentials: OracleCredentials): PoolTarget => ({
      id: credentials.user,
      info: {
        kind: 'oracle',
        host: oracle().container.getHost(),
        port: oracle().container.getMappedPort(ORACLE_PORT),
        username: credentials.user,
        password: credentials.password,
        oracleServiceName: 'FREEPDB1',
      },
    });

    const detect = (credentials: OracleCredentials, schema?: string): Promise<QuartzDetection> =>
      pools.withConnection(target(credentials), (conn) =>
        detectQuartz(conn, oracleDialect, { schema }),
      );

    const setOf = (detection: QuartzDetection, prefix: string): DetectedTableSet => {
      const set = detection.tableSets.find((s) => s.prefix === prefix);
      if (!set) throw new Error(`${prefix} 세트를 찾지 못했습니다: ${JSON.stringify(detection)}`);
      return set;
    };

    async function exec(
      conn: oracledb.Connection,
      sql: string,
      binds: unknown[] = [],
    ): Promise<void> {
      await conn.execute(sql, binds as oracledb.BindParameters);
    }

    beforeAll(async () => {
      cluster = await startQuartzCluster({ nodes: 2 });
      owner = { user: oracle().user, password: oracle().password };
      pools = new TargetPoolManager([new OracleAdapter()]);

      // 기본 prefix 세트에 실제 Quartz가 저장한 잡과 트리거를 둔다
      await cluster.nodes[0]!.client.scheduleJob({
        job: { name: 'detect-job', group: 'detect', type: 'RecordingJob', data: { k: 'v' } },
        trigger: { name: 'detect-trigger', group: 'detect', type: 'simple', intervalMs: 3_600_000 },
      });

      const dbNow = await pools.withConnection(target(owner), (c) =>
        queryDbNowMillis(c, oracleDialect),
      );
      await oracle().withConnection(async (conn) => {
        await initQuartzSchema(conn, batch);
        const t = (name: (typeof QUARTZ_TABLES)[number]) => quartzTableName(name, batch);
        for (const [job, durable] of [
          ['a1', 'Y'],
          ['a2', 'N'],
        ] as const) {
          await exec(
            conn,
            `INSERT INTO ${t('JOB_DETAILS')} (SCHED_NAME, JOB_NAME, JOB_GROUP, JOB_CLASS_NAME, IS_DURABLE,
             IS_NONCONCURRENT, IS_UPDATE_DATA, REQUESTS_RECOVERY) VALUES ('BatchA', :1, 'g', 'x.Job', :2, 'N', 'N', 'N')`,
            [job, durable],
          );
        }
        await exec(
          conn,
          `INSERT INTO ${t('TRIGGERS')} (SCHED_NAME, TRIGGER_NAME, TRIGGER_GROUP, JOB_NAME, JOB_GROUP,
           NEXT_FIRE_TIME, PREV_FIRE_TIME, TRIGGER_STATE, TRIGGER_TYPE, START_TIME)
         VALUES ('BatchA', 't1', 'g', 'a1', 'g', :1, -1, 'WAITING', 'SIMPLE', :2)`,
          [dbNow + 3_600_000, dbNow],
        );
        // 활성 노드 1개, 체크인이 멈춘 노드 1개
        await exec(
          conn,
          `INSERT INTO ${t('SCHEDULER_STATE')} VALUES ('BatchA', 'live', :1, 7500)`,
          [dbNow],
        );
        await exec(
          conn,
          `INSERT INTO ${t('SCHEDULER_STATE')} VALUES ('BatchA', 'dead', :1, 7500)`,
          [dbNow - 600_000],
        );
        // BatchB는 잠금 행만 있다(아직 아무것도 등록하지 않은 스케줄러)
        for (const lock of ['TRIGGER_ACCESS', 'STATE_ACCESS']) {
          await exec(conn, `INSERT INTO ${t('LOCKS')} VALUES ('BatchA', :1)`, [lock]);
          await exec(conn, `INSERT INTO ${t('LOCKS')} VALUES ('BatchB', :1)`, [lock]);
        }
        await conn.commit();

        // 필수 테이블이 빠진 세트
        await initQuartzSchema(conn, { prefix: 'BROKEN_' });
        await exec(conn, `DROP TABLE ${quartzTableName('LOCKS', { prefix: 'BROKEN_' })} PURGE`);

        // 읽기 전용 계정과 LOCKS UPDATE만 없는 계정
        reader = await oracle().createUser('READER', 'Reader_test1');
        noLock = await oracle().createUser('NOLOCK', 'NoLock_test1');
        for (const prefix of ['QRTZ_', 'BATCH_']) {
          for (const table of QUARTZ_TABLES) {
            const name = quartzTableName(table, { prefix });
            await exec(conn, `GRANT SELECT ON ${name} TO READER`);
            const privileges =
              table === 'LOCKS' ? 'SELECT, INSERT, DELETE' : 'SELECT, INSERT, UPDATE, DELETE';
            await exec(conn, `GRANT ${privileges} ON ${name} TO NOLOCK`);
          }
        }
      });

      const lower = await oracle().createUser('LOWERQ', 'LowerQ_test1');
      await oracle().withConnection(
        (conn) => initQuartzSchema(conn, { tableCase: 'lower' }),
        lower,
      );
      const q23 = await oracle().createUser('Q23', 'Q23_test1');
      await oracle().withConnection((conn) => initQuartzSchema(conn, { variant: 'oracle23' }), q23);
    });

    afterAll(async () => {
      await pools?.closeAll();
      await cluster?.stop();
    });

    it('기본 prefix와 사용자 지정 prefix가 한 스키마에 함께 있어도 각각 감지한다', async () => {
      const detection = await detect(owner);
      expect(detection.schema).toBe('QUARTZ');
      expect(detection.tableSets.map((s) => s.prefix).sort()).toEqual(['BATCH_', 'QRTZ_']);

      const qrtz = setOf(detection, 'QRTZ_');
      expect(qrtz.tableNames).toMatchObject({ TRIGGERS: 'QRTZ_TRIGGERS', LOCKS: 'QRTZ_LOCKS' });
      expect(qrtz.tableNames.SIMPROP_TRIGGERS).toBe('QRTZ_SIMPROP_TRIGGERS');
      expect(qrtz.features).toEqual({
        simpropTriggers: true,
        triggerPriority: true,
        firedPriority: true,
        firedSchedTime: true,
        jobNonconcurrent: true,
        jobUpdateData: true,
        cronTimeZone: true,
      });
      // 테스트베드는 운영과 같은 '1'/'0'으로 저장한다 (TRD §12.1)
      expect(qrtz).toMatchObject({
        boolFormat: '10',
        boolFormatSource: 'values',
        writeCapable: true,
      });
      expect(qrtz.missingPrivileges).toEqual([]);
    });

    it('실제 클러스터의 SCHED_NAME, 잡·트리거 수, 활성 노드 수를 세고 기대 노드 수 초기값으로 쓴다', async () => {
      const qrtz = setOf(await detect(owner), 'QRTZ_');
      expect(qrtz.schedulers).toEqual([
        {
          schedName: cluster.schedulerName,
          jobCount: 1,
          triggerCount: 1,
          nodeCount: 2,
          activeNodeCount: 2,
          expectedNodeCount: 2,
        },
      ]);
    });

    it('한 테이블 세트의 SCHED_NAME 여러 개를 각각 후보로 내놓는다', async () => {
      const set = setOf(await detect(owner), 'BATCH_');
      expect(set.schedulers).toEqual([
        {
          schedName: 'BatchA',
          jobCount: 2,
          triggerCount: 1,
          nodeCount: 2,
          activeNodeCount: 1,
          expectedNodeCount: 1,
        },
        {
          schedName: 'BatchB',
          jobCount: 0,
          triggerCount: 0,
          nodeCount: 0,
          activeNodeCount: 0,
          expectedNodeCount: 0,
        },
      ]);
      expect(set).toMatchObject({ boolFormat: 'YN', boolFormatSource: 'values', warnings: [] });
      // 스키마 파일에 SIMPROP_TRIGGERS가 있으므로 BATCH_ 세트도 선택 테이블을 가진다
      expect(set.features.simpropTriggers).toBe(true);
    });

    it('필수 테이블이 빠진 세트는 이유와 함께 따로 알려준다', async () => {
      const detection = await detect(owner);
      expect(detection.unusable).toEqual([
        { prefix: 'BROKEN_', reason: 'MISSING_TABLES', tables: ['LOCKS'] },
      ]);
    });

    it('따옴표 소문자 테이블을 실제 이름 그대로 감지한다', async () => {
      const detection = await detect({ user: 'LOWERQ', password: 'LowerQ_test1' });
      const set = setOf(detection, 'qrtz_');
      expect(set.tableNames).toMatchObject({
        TRIGGERS: 'qrtz_triggers',
        JOB_DETAILS: 'qrtz_job_details',
      });
      // 잡이 없으면 Quartz 기본 저장값으로 본다
      expect(set).toMatchObject({
        boolFormat: '10',
        boolFormatSource: 'default',
        writeCapable: true,
      });
      expect(set.schedulers).toEqual([]);
    });

    it('Oracle 23 BOOLEAN 스키마는 native로 판정한다', async () => {
      const set = setOf(await detect({ user: 'Q23', password: 'Q23_test1' }), 'QRTZ_');
      expect(set).toMatchObject({ boolFormat: 'native', boolFormatSource: 'column-type' });
    });

    it('읽기 전용 계정은 다른 스키마의 테이블을 감지하되 write_capable=false로 판정한다', async () => {
      const detection = await detect(reader, 'quartz'); // 소문자로 입력해도 찾는다
      expect(detection.schema).toBe('QUARTZ');
      const qrtz = setOf(detection, 'QRTZ_');
      expect(qrtz.writeCapable).toBe(false);
      expect(qrtz.missingPrivileges).toContainEqual({
        table: 'TRIGGERS',
        privilege: 'UPDATE',
        driverCode: PRIVILEGE_ERROR,
      });
      expect(qrtz.missingPrivileges.some((m) => m.privilege === 'SELECT')).toBe(false);
      expect(qrtz.schedulers.map((s) => s.schedName)).toEqual([cluster.schedulerName]);
      // 권한이 없는 BROKEN_ 세트는 이 계정에 보이지 않는다
      expect(detection.unusable).toEqual([]);
    });

    it('LOCKS의 UPDATE 권한(잠금)만 없어도 write_capable=false', async () => {
      const qrtz = setOf(await detect(noLock, 'QUARTZ'), 'QRTZ_');
      expect(qrtz.writeCapable).toBe(false);
      expect(qrtz.missingPrivileges).toEqual([
        { table: 'LOCKS', privilege: 'UPDATE', driverCode: PRIVILEGE_ERROR },
      ]);
    });

    it('감지 결과로 만든 TableSet으로 실제 Quartz가 저장한 트리거와 노드를 조회한다 (B-14)', async () => {
      const set = setOf(await detect(owner), 'QRTZ_');
      const ctx = {
        dialect: oracleDialect,
        tables: createTableSet(oracleDialect, { schema: 'QUARTZ', tables: set.tableNames }),
        features: set.features,
        schedName: cluster.schedulerName,
      };
      const { dbNow } = await detect(owner);
      const [triggers, nodes] = await pools.withConnection(
        target(owner),
        async (conn) =>
          [
            await listTriggers(conn, ctx, { sort: 'key', page: 1, size: 50 }),
            await listNodes(conn, ctx, { dbNow, checkinMultiplier: 3 }),
          ] as const,
      );
      expect(triggers.items).toEqual([
        expect.objectContaining({
          group: 'detect',
          name: 'detect-trigger',
          jobName: 'detect-job',
          type: 'SIMPLE',
          simple: {
            repeatCount: -1,
            repeatIntervalMs: 3_600_000,
            timesTriggered: expect.any(Number) as number,
          },
        }),
      ]);
      expect(nodes.map((n) => [n.instanceName, n.active])).toEqual([
        ['node-1', true],
        ['node-2', true],
      ]);
    });

    it('감지는 행을 바꾸거나 잠그지 않는다', async () => {
      const snapshot = () =>
        oracle().withConnection(async (conn) => {
          const out: Record<string, unknown> = {};
          for (const table of QUARTZ_TABLES) {
            const result = await conn.execute(
              `SELECT * FROM ${quartzTableName(table, batch)} ORDER BY 1, 2`,
            );
            out[table] = result.rows;
          }
          return JSON.stringify(out);
        });
      const before = await snapshot();

      // 다른 세션이 BATCH_ 세트의 모든 행을 잠그고 있어도 감지는 기다리지 않는다
      const holder = await oracle().connect();
      try {
        for (const table of ['TRIGGERS', 'JOB_DETAILS', 'LOCKS', 'SCHEDULER_STATE'] as const) {
          await holder.execute(`SELECT * FROM ${quartzTableName(table, batch)} FOR UPDATE`);
        }
        // 풀을 거치지 않고 감지해, 감지가 끝난 뒤 커밋하지 않은 트랜잭션이 남지 않았는지 직접 본다
        const conn = await new OracleAdapter().connect(target(owner).info, {
          connectTimeoutMs: 10_000,
          queryTimeoutMs: 10_000,
        });
        try {
          const started = Date.now();
          const detection = await detectQuartz(conn, oracleDialect);
          expect(Date.now() - started).toBeLessThan(5_000);
          expect(setOf(detection, 'BATCH_').writeCapable).toBe(true);
          expect(conn.inTransaction).toBe(false);
        } finally {
          await conn.close();
        }
      } finally {
        await holder.rollback();
        await holder.close();
      }

      expect(await snapshot()).toBe(before);
    });
  },
);
