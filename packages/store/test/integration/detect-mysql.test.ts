import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MariadbAdapter,
  MysqlAdapter,
  TargetPoolManager,
  createTableSet,
  detectQuartz,
  listNodes,
  listTriggers,
  mariadbDialect,
  mysqlDialect,
  queryDbNowMillis,
  type DetectedTableSet,
  type PoolTarget,
  type QuartzDetection,
  type TargetConnectInfo,
} from '../../src/index.js';
import {
  QUARTZ_TABLES,
  QUARTZ_VERSION,
  TEST_DB,
  TEST_DB_LABEL,
  initQuartzSchema,
  isMysqlFamily,
  quartzTableName,
  startMysql,
  startQuartzCluster,
  type DbCredentials,
  type MysqlFixture,
  type QuartzCluster,
  type QuartzSchemaOptions,
  type TestConnection,
} from '../support/index.js';

const flavor = TEST_DB === 'mariadb' ? 'mariadb' : 'mysql';
const dialect = flavor === 'mariadb' ? mariadbDialect : mysqlDialect;

/**
 * 자동 감지 (B-28, B-29, TRD §5.5)를 MySQL·MariaDB에서. quartz DB에 다음을 둔다.
 * - 테스트베드 2노드 클러스터의 `QRTZ_`, SQL로 채운 `BATCH_`(SCHED_NAME 2개, 불리언 `Y`/`N`), 필수 테이블이 빠진 `BROKEN_`
 * - reader: SELECT 권한만 있는 계정, nolock: LOCKS의 UPDATE만 없는 계정
 * 그리고 `lower_case_table_names=1` 서버를 따로 띄워 소문자로 저장된 테이블을 감지한다.
 * `QA_IT_DB=mysql` 또는 `mariadb`일 때만 돈다.
 */
describe.skipIf(!isMysqlFamily(TEST_DB))(
  `자동 감지 (${TEST_DB_LABEL}, Quartz ${QUARTZ_VERSION})`,
  () => {
    let cluster: QuartzCluster;
    let lower: MysqlFixture;
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
      pools.withConnection(target(credentials), (conn) => detectQuartz(conn, dialect, { schema }));
    const setOf = (detection: QuartzDetection, prefix: string): DetectedTableSet => {
      const set = detection.tableSets.find((s) => s.prefix === prefix);
      if (!set) throw new Error(`${prefix} 세트를 찾지 못했습니다: ${JSON.stringify(detection)}`);
      return set;
    };
    const exec = (conn: TestConnection, sql: string, binds: unknown[] = []) =>
      conn.execute(sql, binds);

    beforeAll(async () => {
      [cluster, lower] = await Promise.all([
        startQuartzCluster({ nodes: 2 }),
        startMysql({ flavor, lowerCaseTableNames: true }),
      ]);
      owner = { user: cluster.db.user, password: cluster.db.password };
      pools = new TargetPoolManager([new MysqlAdapter(), new MariadbAdapter()]);

      await cluster.nodes[0]!.client.scheduleJob({
        job: { name: 'detect-job', group: 'detect', type: 'RecordingJob', data: { k: 'v' } },
        trigger: { name: 'detect-trigger', group: 'detect', type: 'simple', intervalMs: 3_600_000 },
      });
      const dbNow = await pools.withConnection(target(owner), (c) => queryDbNowMillis(c, dialect));

      await cluster.db.withConnection(async (conn) => {
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
      });

      reader = await cluster.db.createUser('reader', 'Reader_test1');
      noLock = await cluster.db.createUser('nolock', 'NoLock_test1');
      const root = await cluster.db.mysql!.connectRoot();
      try {
        for (const prefix of ['QRTZ_', 'BATCH_']) {
          for (const table of QUARTZ_TABLES) {
            const name = `quartz.${quartzTableName(table, { prefix })}`;
            await root.query(`GRANT SELECT ON ${name} TO 'reader'@'%'`);
            const privileges =
              table === 'LOCKS' ? 'SELECT, INSERT, DELETE' : 'SELECT, INSERT, UPDATE, DELETE';
            await root.query(`GRANT ${privileges} ON ${name} TO 'nolock'@'%'`);
          }
        }
      } finally {
        await root.end();
      }

      // lower_case_table_names=1 서버: Quartz처럼 대문자로 만들어도 소문자로 저장된다
      const lowerConn = await lower.connect();
      try {
        const { quartzSchemaStatements, readQuartzSchemaSql } =
          await import('../support/quartz-schema.js');
        for (const statement of quartzSchemaStatements(readQuartzSchemaSql('mysql'), {
          db: 'mysql',
        })) {
          await lowerConn.query(statement);
        }
      } finally {
        await lowerConn.end();
      }
    }, 600_000);

    afterAll(async () => {
      await pools?.closeAll();
      await Promise.allSettled([cluster?.stop(), lower?.stop()]);
    });

    it('현재 DB(quartz)의 기본 prefix와 사용자 지정 prefix를 각각 감지한다', async () => {
      const detection = await detect(owner);
      expect(detection.schema).toBe('quartz');
      expect(detection.tableSets.map((s) => s.prefix).sort()).toEqual(['BATCH_', 'QRTZ_']);
      const qrtz = setOf(detection, 'QRTZ_');
      expect(qrtz.tableNames).toMatchObject({
        TRIGGERS: 'QRTZ_TRIGGERS',
        LOCKS: 'QRTZ_LOCKS',
        SIMPROP_TRIGGERS: 'QRTZ_SIMPROP_TRIGGERS',
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
      // Quartz(StdJDBCDelegate)가 VARCHAR(1)에 '1'/'0'으로 저장한다
      expect(qrtz).toMatchObject({
        boolFormat: '10',
        boolFormatSource: 'values',
        writeCapable: true,
        missingPrivileges: [],
        // 서버 기본 격리 수준이 REPEATABLE READ라 노드 설정을 확인하라는 경고가 붙는다 (TRD §5.3)
        warnings: ['REPEATABLE_READ_MISFIRE_RACE'],
      });
    });

    it('실제 클러스터와 SQL로 채운 세트의 SCHED_NAME, 잡·트리거 수, 활성 노드 수', async () => {
      const detection = await detect(owner);
      expect(setOf(detection, 'QRTZ_').schedulers).toEqual([
        {
          schedName: cluster.schedulerName,
          jobCount: 1,
          triggerCount: 1,
          nodeCount: 2,
          activeNodeCount: 2,
          expectedNodeCount: 2,
        },
      ]);
      const batchSet = setOf(detection, 'BATCH_');
      expect(batchSet.schedulers).toEqual([
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
      expect(batchSet).toMatchObject({ boolFormat: 'YN', boolFormatSource: 'values' });
      expect(detection.unusable).toEqual([
        { prefix: 'BROKEN_', reason: 'MISSING_TABLES', tables: ['LOCKS'] },
      ]);
    });

    it('lower_case_table_names=1 서버의 소문자 테이블을 실제 이름 그대로 감지하고, READ COMMITTED 서버에는 격리 수준 경고가 없다', async () => {
      // 10.3에는 transaction_isolation 별칭이 없다
      const root = await lower.connectRoot();
      try {
        await root.query(
          flavor === 'mariadb'
            ? "SET GLOBAL tx_isolation = 'READ-COMMITTED'"
            : "SET GLOBAL transaction_isolation = 'READ-COMMITTED'",
        );
      } finally {
        await root.end();
      }
      const info: TargetConnectInfo = {
        kind: flavor,
        host: lower.host,
        port: lower.port,
        username: lower.user,
        password: lower.password,
        database: lower.database,
      };
      const detection = await pools.withConnection({ id: 'lower', info }, (conn) =>
        detectQuartz(conn, dialect),
      );
      const set = setOf(detection, 'qrtz_');
      expect(set.tableNames).toMatchObject({
        TRIGGERS: 'qrtz_triggers',
        JOB_DETAILS: 'qrtz_job_details',
      });
      expect(set).toMatchObject({
        boolFormat: '10',
        boolFormatSource: 'default',
        writeCapable: true,
        warnings: [],
      });
      expect(set.schedulers).toEqual([]);
    });

    it('SELECT 권한만 있는 계정은 테이블을 감지하되 write_capable=false', async () => {
      const qrtz = setOf(await detect(reader, 'quartz'), 'QRTZ_');
      expect(qrtz.writeCapable).toBe(false);
      expect(qrtz.missingPrivileges).toContainEqual({
        table: 'TRIGGERS',
        privilege: 'UPDATE',
        driverCode: 'ER_TABLEACCESS_DENIED_ERROR',
      });
      expect(qrtz.missingPrivileges.some((m) => m.privilege === 'SELECT')).toBe(false);
      expect(qrtz.schedulers.map((s) => s.schedName)).toEqual([cluster.schedulerName]);
    });

    it('LOCKS의 UPDATE 권한(잠금)만 없어도 write_capable=false', async () => {
      const qrtz = setOf(await detect(noLock, 'quartz'), 'QRTZ_');
      expect(qrtz.writeCapable).toBe(false);
      expect(qrtz.missingPrivileges).toEqual([
        { table: 'LOCKS', privilege: 'UPDATE', driverCode: 'ER_TABLEACCESS_DENIED_ERROR' },
      ]);
    });

    it('감지 결과로 만든 TableSet으로 실제 Quartz가 저장한 트리거와 노드를 조회한다', async () => {
      const detection = await detect(owner);
      const set = setOf(detection, 'QRTZ_');
      const ctx = {
        dialect: dialect,
        tables: createTableSet(dialect, { schema: detection.schema, tables: set.tableNames }),
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
