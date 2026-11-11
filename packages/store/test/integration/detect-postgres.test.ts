import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresAdapter,
  TargetPoolManager,
  createTableSet,
  detectQuartz,
  listNodes,
  listTriggers,
  postgresDialect,
  queryDbNowMillis,
  type DetectedTableSet,
  type PoolTarget,
  type QuartzDetection,
} from '../../src/index.js';
import {
  POSTGRES_VERSION,
  QUARTZ_TABLES,
  QUARTZ_VERSION,
  TEST_DB,
  initQuartzSchema,
  quartzTableName,
  startQuartzCluster,
  type DbCredentials,
  type QuartzCluster,
  type QuartzSchemaOptions,
  type TestConnection,
} from '../support/index.js';

/**
 * 자동 감지 (B-27, TRD §5.5)를 PostgreSQL에서. 한 DB에 다음을 둔다.
 * - public: 테스트베드 2노드 클러스터의 `qrtz_`(따옴표 없이 만들어 소문자), SQL로 채운 `batch_`(SCHED_NAME 2개),
 *   필수 테이블이 빠진 `broken_`
 * - upperq 스키마: 따옴표 대문자 테이블(`"QRTZ_TRIGGERS"`)
 * - reader: public 테이블에 SELECT 권한만 있는 역할, nolock: LOCKS의 UPDATE만 없는 역할
 * `QA_IT_DB=postgres`일 때만 돈다.
 */
describe.skipIf(TEST_DB !== 'postgres')(
  `자동 감지 (PostgreSQL ${POSTGRES_VERSION}, Quartz ${QUARTZ_VERSION})`,
  () => {
    let cluster: QuartzCluster;
    let pools: TargetPoolManager;
    let owner: DbCredentials;
    let reader: DbCredentials;
    let noLock: DbCredentials;
    const batch: QuartzSchemaOptions = { prefix: 'BATCH_' };

    const target = (credentials: DbCredentials): PoolTarget => ({
      id: credentials.user,
      info: cluster.db.targetInfo(credentials),
    });
    const detect = (credentials: DbCredentials, schema?: string): Promise<QuartzDetection> =>
      pools.withConnection(target(credentials), (conn) =>
        detectQuartz(conn, postgresDialect, { schema }),
      );
    const setOf = (detection: QuartzDetection, prefix: string): DetectedTableSet => {
      const set = detection.tableSets.find((s) => s.prefix === prefix);
      if (!set) throw new Error(`${prefix} 세트를 찾지 못했습니다: ${JSON.stringify(detection)}`);
      return set;
    };
    const exec = (conn: TestConnection, sql: string, binds: unknown[] = []) =>
      conn.execute(sql, binds);

    beforeAll(async () => {
      cluster = await startQuartzCluster({ nodes: 2 });
      owner = { user: cluster.db.user, password: cluster.db.password };
      pools = new TargetPoolManager([new PostgresAdapter()]);

      await cluster.nodes[0]!.client.scheduleJob({
        job: { name: 'detect-job', group: 'detect', type: 'RecordingJob', data: { k: 'v' } },
        trigger: { name: 'detect-trigger', group: 'detect', type: 'simple', intervalMs: 3_600_000 },
      });
      const dbNow = await pools.withConnection(target(owner), (c) =>
        queryDbNowMillis(c, postgresDialect),
      );

      await cluster.db.withConnection(async (conn) => {
        await initQuartzSchema(conn, batch);
        const t = (name: (typeof QUARTZ_TABLES)[number]) => quartzTableName(name, batch);
        for (const [job, durable] of [
          ['a1', true],
          ['a2', false],
        ] as const) {
          await exec(
            conn,
            `INSERT INTO ${t('JOB_DETAILS')} (SCHED_NAME, JOB_NAME, JOB_GROUP, JOB_CLASS_NAME, IS_DURABLE,
               IS_NONCONCURRENT, IS_UPDATE_DATA, REQUESTS_RECOVERY) VALUES ('BatchA', :1, 'g', 'x.Job', :2, false, false, false)`,
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
        for (const lock of ['TRIGGER_ACCESS', 'STATE_ACCESS']) {
          await exec(conn, `INSERT INTO ${t('LOCKS')} VALUES ('BatchA', :1)`, [lock]);
          await exec(conn, `INSERT INTO ${t('LOCKS')} VALUES ('BatchB', :1)`, [lock]);
        }
        await conn.commit();

        await initQuartzSchema(conn, { prefix: 'BROKEN_' });
        await exec(conn, `DROP TABLE ${quartzTableName('LOCKS', { prefix: 'BROKEN_' })}`);

        reader = await cluster.db.createUser('reader', 'Reader_test1');
        noLock = await cluster.db.createUser('nolock', 'NoLock_test1');
        for (const prefix of ['QRTZ_', 'BATCH_']) {
          for (const table of QUARTZ_TABLES) {
            const name = quartzTableName(table, { prefix });
            await exec(conn, `GRANT SELECT ON ${name} TO reader`);
            const privileges =
              table === 'LOCKS' ? 'SELECT, INSERT, DELETE' : 'SELECT, INSERT, UPDATE, DELETE';
            await exec(conn, `GRANT ${privileges} ON ${name} TO nolock`);
          }
        }

        // 따옴표 대문자 테이블. 같은 이름의 스키마를 만들어 그 안에 둔다
        await exec(conn, `CREATE SCHEMA upperq`);
        for (const table of QUARTZ_TABLES) {
          await exec(
            conn,
            `CREATE TABLE upperq."QRTZ_${table}" (LIKE public.qrtz_${table.toLowerCase()} INCLUDING ALL)`,
          );
        }
      });
    });

    afterAll(async () => {
      await pools?.closeAll();
      await cluster?.stop();
    });

    it('현재 스키마(public)의 소문자 기본 prefix와 사용자 지정 prefix를 각각 감지하고, BOOL 컬럼은 native', async () => {
      const detection = await detect(owner);
      expect(detection.schema).toBe('public');
      expect(detection.tableSets.map((s) => s.prefix).sort()).toEqual(['batch_', 'qrtz_']);
      const qrtz = setOf(detection, 'qrtz_');
      expect(qrtz.tableNames).toMatchObject({
        TRIGGERS: 'qrtz_triggers',
        LOCKS: 'qrtz_locks',
        SIMPROP_TRIGGERS: 'qrtz_simprop_triggers',
      });
      expect(qrtz.features).toEqual({
        simpropTriggers: true,
        triggerPriority: true,
        firedPriority: true,
        firedSchedTime: true,
        jobNonconcurrent: true,
        jobUpdateData: true,
        cronTimeZone: true,
      });
      expect(qrtz).toMatchObject({
        boolFormat: 'native',
        boolFormatSource: 'column-type',
        writeCapable: true,
        missingPrivileges: [],
      });
    });

    it('실제 클러스터와 SQL로 채운 세트의 SCHED_NAME, 잡·트리거 수, 활성 노드 수', async () => {
      const detection = await detect(owner);
      expect(setOf(detection, 'qrtz_').schedulers).toEqual([
        {
          schedName: cluster.schedulerName,
          jobCount: 1,
          triggerCount: 1,
          nodeCount: 2,
          activeNodeCount: 2,
          expectedNodeCount: 2,
        },
      ]);
      expect(setOf(detection, 'batch_').schedulers).toEqual([
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
      expect(detection.unusable).toEqual([
        { prefix: 'broken_', reason: 'MISSING_TABLES', tables: ['LOCKS'] },
      ]);
    });

    it('따옴표 대문자 테이블은 다른 스키마를 지정해 실제 이름 그대로 감지한다', async () => {
      const detection = await detect(owner, 'upperq');
      expect(detection.schema).toBe('upperq');
      const set = setOf(detection, 'QRTZ_');
      expect(set.tableNames).toMatchObject({
        TRIGGERS: 'QRTZ_TRIGGERS',
        JOB_DETAILS: 'QRTZ_JOB_DETAILS',
      });
      expect(set).toMatchObject({ boolFormat: 'native', writeCapable: true, schedulers: [] });
    });

    it('SELECT 권한만 있는 역할은 public 테이블을 감지하되 write_capable=false', async () => {
      const qrtz = setOf(await detect(reader, 'public'), 'qrtz_');
      expect(qrtz.writeCapable).toBe(false);
      // 42501 insufficient_privilege
      expect(qrtz.missingPrivileges).toContainEqual({
        table: 'TRIGGERS',
        privilege: 'UPDATE',
        driverCode: '42501',
      });
      expect(qrtz.missingPrivileges.some((m) => m.privilege === 'SELECT')).toBe(false);
      expect(qrtz.schedulers.map((s) => s.schedName)).toEqual([cluster.schedulerName]);
    });

    it('LOCKS의 UPDATE 권한(잠금)만 없어도 write_capable=false', async () => {
      const qrtz = setOf(await detect(noLock, 'public'), 'qrtz_');
      expect(qrtz.writeCapable).toBe(false);
      expect(qrtz.missingPrivileges).toEqual([
        { table: 'LOCKS', privilege: 'UPDATE', driverCode: '42501' },
      ]);
    });

    it('감지 결과로 만든 TableSet으로 실제 Quartz가 저장한 트리거와 노드를 조회한다', async () => {
      const detection = await detect(owner);
      const set = setOf(detection, 'qrtz_');
      const ctx = {
        dialect: postgresDialect,
        tables: createTableSet(postgresDialect, {
          schema: detection.schema,
          tables: set.tableNames,
        }),
        features: set.features,
        schedName: cluster.schedulerName,
      };
      const [triggers, nodes] = await pools.withConnection(
        target(owner),
        async (conn) =>
          [
            await listTriggers(conn, ctx, { sort: 'key', page: 1, size: 50 }),
            await listNodes(conn, ctx, { dbNow: detection.dbNow, checkinMultiplier: 3 }),
          ] as const,
      );
      expect(triggers.items.map((t) => [t.group, t.name, t.type])).toEqual([
        ['detect', 'detect-trigger', 'SIMPLE'],
      ]);
      expect(nodes.map((n) => [n.instanceName, n.active])).toEqual([
        ['node-1', true],
        ['node-2', true],
      ]);
    });
  },
);
