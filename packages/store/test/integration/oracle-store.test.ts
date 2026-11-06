import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OracleAdapter,
  QUARTZ_REQUIRED_TABLES,
  TargetPoolManager,
  createTableSet,
  oracleDialect,
  queryDbNowMillis,
  readTime,
  type PoolTarget,
  type QuartzTableKey,
  type TargetConn,
  type TargetConnectInfo,
} from '../../src/index.js';
import {
  initQuartzSchema,
  sleep,
  startOracle,
  startTcpProxy,
  waitFor,
  type OracleFixture,
  type TcpProxy,
} from '../support/index.js';

const ORACLE_PORT = 1521;
const queryOptions = { connectTimeoutMs: 10_000, queryTimeoutMs: 10_000 };

describe('@qa/store Oracle 어댑터와 커넥션 풀 (Oracle Free 23)', () => {
  let oracle: OracleFixture;
  let info: TargetConnectInfo;
  const adapter = new OracleAdapter();

  beforeAll(async () => {
    oracle = await startOracle();
    info = {
      kind: 'oracle',
      host: oracle.container.getHost(),
      port: oracle.container.getMappedPort(ORACLE_PORT),
      username: oracle.user,
      password: oracle.password,
      oracleServiceName: 'FREEPDB1',
    };
  });

  afterAll(async () => {
    await oracle?.stop();
  });

  async function withConn<T>(fn: (conn: TargetConn) => Promise<T>, i = info): Promise<T> {
    const conn = await adapter.connect(i, queryOptions);
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }

  /** SYSTEM으로 본 계정의 세션 수 */
  async function sessionCount(user: string): Promise<number> {
    return oracle.withSystemConnection(async (conn) => {
      const result = await conn.execute<[number]>(
        `SELECT COUNT(*) FROM V$SESSION WHERE USERNAME = :p1`,
        [user.toUpperCase()],
      );
      return result.rows?.[0]?.[0] ?? -1;
    });
  }

  describe('어댑터 (S3: Thin 모드, BLOB·NUMBER 매핑)', () => {
    it('Thin 모드로 접속해 객체 형식 행을 돌려준다', async () => {
      const rows = await withConn((c) => c.query(`SELECT 1 AS N, 'a' AS S FROM DUAL`));
      expect(rows).toEqual([{ N: 1, S: 'a' }]);
    });

    it('NUMBER(13)은 JS number, BLOB은 Buffer, NULL BLOB은 null로 받는다', async () => {
      await withConn(async (c) => {
        await c.execute(
          `CREATE TABLE S3_MAPPING (ID NUMBER(13) PRIMARY KEY, DATA BLOB, FLAG VARCHAR2(1), MISSING NUMBER(13))`,
        );
        const payload = Buffer.from([0xac, 0xed, 0x00, 0x05, 0x73, 0x72]);
        await c.execute(`INSERT INTO S3_MAPPING (ID, DATA, FLAG) VALUES (:p1, :p2, :p3)`, [
          1_762_400_000_123,
          payload,
          '1',
        ]);
        await c.execute(
          `INSERT INTO S3_MAPPING (ID, DATA, FLAG, MISSING) VALUES (:p1, NULL, '0', -1)`,
          [2],
        );
        await c.commit();

        const rows = await c.query(`SELECT ID, DATA, FLAG, MISSING FROM S3_MAPPING ORDER BY ID`);
        expect(rows).toHaveLength(2);
        const [first, second] = rows as [Record<string, unknown>, Record<string, unknown>];
        expect(first.ID).toBe(2);
        expect(oracleDialect.readBlob(first.DATA)).toBeNull();
        expect(oracleDialect.readBool(first.FLAG)).toBe(false);
        expect(readTime(first.MISSING)).toBeNull();
        expect(second.ID).toBe(1_762_400_000_123);
        expect(typeof second.ID).toBe('number');
        expect(Buffer.isBuffer(second.DATA)).toBe(true);
        expect(oracleDialect.readBlob(second.DATA)).toEqual(payload);
        expect(oracleDialect.readBool(second.FLAG)).toBe(true);
        expect(readTime(second.MISSING)).toBeNull();
      });
    });

    it('Quartz 스키마를 TableSet으로 조회한다(VARCHAR2 불리언과 Oracle 23 BOOLEAN)', async () => {
      await withConn(async (c) => {
        const executor = { execute: (sql: string) => c.execute(sql) };
        await initQuartzSchema(executor, { prefix: 'QRTZ_' });
        await initQuartzSchema(executor, { prefix: 'Q23_', variant: 'oracle23' });

        for (const [prefix, durable] of [
          ['QRTZ_', `'1'`],
          ['Q23_', 'TRUE'],
        ] as const) {
          const tables = Object.fromEntries(
            QUARTZ_REQUIRED_TABLES.map((t) => [t, `${prefix}${t}`]),
          ) as Record<QuartzTableKey, string>;
          const set = createTableSet(oracleDialect, { schema: oracle.user, tables });
          await c.execute(
            `INSERT INTO ${set.table('JOB_DETAILS')}
               (SCHED_NAME, JOB_NAME, JOB_GROUP, JOB_CLASS_NAME, IS_DURABLE, IS_NONCONCURRENT,
                IS_UPDATE_DATA, REQUESTS_RECOVERY, JOB_DATA)
             VALUES (:p1, :p2, :p3, :p4, ${durable}, ${durable === 'TRUE' ? 'FALSE' : `'0'`},
                ${durable === 'TRUE' ? 'FALSE' : `'0'`}, ${durable === 'TRUE' ? 'FALSE' : `'0'`}, :p5)`,
            ['S', 'job', 'grp', 'example.Job', Buffer.from('jobdata')],
          );
          await c.commit();
          const rows = await c.query(
            `SELECT IS_DURABLE, IS_NONCONCURRENT, JOB_DATA FROM ${set.table('JOB_DETAILS')} WHERE SCHED_NAME = :p1`,
            ['S'],
          );
          expect(oracleDialect.readBool(rows[0]?.IS_DURABLE)).toBe(true);
          expect(oracleDialect.readBool(rows[0]?.IS_NONCONCURRENT)).toBe(false);
          expect(oracleDialect.readBlob(rows[0]?.JOB_DATA)?.toString()).toBe('jobdata');
        }
      });
    });

    it('DB 현재 시각(ms)이 테스트 프로세스 시각과 가깝다', async () => {
      const before = Date.now();
      const now = await withConn((c) => queryDbNowMillis(c, oracleDialect));
      const after = Date.now();
      expect(now).toBeGreaterThan(before - 5_000);
      expect(now).toBeLessThan(after + 5_000);
    });

    it('OFFSET … FETCH 페이지네이션이 동작한다', async () => {
      const rows = await withConn((c) =>
        c.query(
          oracleDialect.paginate(
            `SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= 10 ORDER BY 1`,
            1,
            2,
          ),
          [3, 4],
        ),
      );
      expect(rows.map((r) => r.N)).toEqual([5, 6, 7]);
    });

    it('FOR UPDATE WAIT를 넘기면 LOCK_TIMEOUT이고, 행은 바뀌지 않는다', async () => {
      await withConn(async (holder) => {
        await holder.execute(`CREATE TABLE S3_LOCK (ID NUMBER PRIMARY KEY, V NUMBER)`);
        await holder.execute(`INSERT INTO S3_LOCK VALUES (1, 0)`);
        await holder.commit();
        await holder.query(`SELECT V FROM S3_LOCK WHERE ID = 1 ${oracleDialect.forUpdate(5)}`);
        expect(holder.inTransaction).toBe(true);

        await withConn(async (other) => {
          const started = Date.now();
          await expect(
            other.query(`SELECT V FROM S3_LOCK WHERE ID = 1 ${oracleDialect.forUpdate(1)}`),
          ).rejects.toMatchObject({
            code: 'LOCK_TIMEOUT',
            // Oracle 23은 WAIT 초과도 ORA-00054로 알린다. 이전 버전은 ORA-30006
            driverCode: expect.stringMatching(/^ORA-(00054|30006)$/) as unknown,
          });
          expect(Date.now() - started).toBeLessThan(5_000);
        });
        await holder.rollback();
        expect(holder.inTransaction).toBe(false);
      });
    });

    it('쿼리 실행 제한을 넘기면 TARGET_TIMEOUT', async () => {
      await withConn(async (c) => {
        const started = Date.now();
        await expect(
          c.execute(`BEGIN DBMS_SESSION.SLEEP(5); END;`, [], { timeoutMs: 1_000 }),
        ).rejects.toMatchObject({ code: 'TARGET_TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(4_000);
      });
    });

    it('틀린 비밀번호는 TARGET_AUTH_FAILED이고 메시지에 접속 정보가 없다', async () => {
      const err = await adapter
        .connect({ ...info, password: 'wrong-password-123' }, queryOptions)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toMatchObject({ code: 'TARGET_AUTH_FAILED', driverCode: 'ORA-01017' });
      const text = JSON.stringify(err);
      for (const secret of [
        info.host,
        `${info.port}`,
        info.username,
        'wrong-password-123',
        'FREEPDB1',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('없는 서비스 이름과 닫힌 포트는 TARGET_UNREACHABLE이고 메시지에 접속 정보가 없다', async () => {
      const proxy = await startTcpProxy(info.host, info.port);
      await proxy.close(); // 이 포트에는 이제 아무도 듣지 않는다
      const cases: TargetConnectInfo[] = [
        { ...info, oracleServiceName: 'NO_SUCH_SERVICE' },
        { ...info, host: '127.0.0.1', port: proxy.port },
      ];
      for (const c of cases) {
        const err = await adapter.connect(c, queryOptions).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toMatchObject({ code: 'TARGET_UNREACHABLE' });
        const text = JSON.stringify(err);
        for (const secret of [`${c.port}`, 'NO_SUCH_SERVICE', info.username, info.password]) {
          expect(text).not.toContain(secret);
        }
      }
    });
  });

  describe('TargetPoolManager', () => {
    let proxy: TcpProxy;
    const fast = { connectTimeoutMs: 3_000, queryTimeoutMs: 3_000, acquireTimeoutMs: 3_000 };

    beforeAll(async () => {
      proxy = await startTcpProxy(info.host, info.port);
    });

    afterAll(async () => {
      await proxy?.close();
    });

    /** 프록시를 거치는 접속(응답하지 않게 만들 대상) */
    const viaProxy = (): PoolTarget => ({
      id: 'hung',
      info: { ...info, host: proxy.host, port: proxy.port },
    });
    const direct = (): PoolTarget => ({ id: 'healthy', info });

    async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
      const started = Date.now();
      const value = await fn();
      return [value, Date.now() - started];
    }

    it('연결 단계에서 응답하지 않는 대상이 있어도 다른 접속의 쿼리는 바로 처리된다 (NFR-REL-01)', async () => {
      const manager = new TargetPoolManager([adapter], fast);
      // 다른 접속 쪽 커넥션을 미리 만들어 둔다(첫 연결 비용을 빼고 잰다)
      await manager.withConnection(direct(), (c) => c.query(`SELECT 1 FROM DUAL`));
      proxy.freeze();
      try {
        const hung = [1, 2].map(() =>
          manager.withConnection(viaProxy(), (c) => c.query(`SELECT 1 FROM DUAL`)),
        );
        const hungResults = Promise.allSettled(hung);
        await sleep(200);

        for (let i = 0; i < 20; i++) {
          const [rows, ms] = await timed(() =>
            manager.withConnection(direct(), (c) => c.query(`SELECT 1 AS N FROM DUAL`)),
          );
          expect(rows).toEqual([{ N: 1 }]);
          expect(ms).toBeLessThan(1_000);
        }

        const results = await hungResults;
        for (const r of results) {
          expect(r.status).toBe('rejected');
          expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'TARGET_TIMEOUT' });
        }
      } finally {
        proxy.thaw();
        await manager.closeAll();
      }
    });

    it('쿼리 도중 응답이 끊긴 대상이 있어도 다른 접속의 쿼리는 바로 처리되고, 끊긴 커넥션은 버린다 (NFR-REL-01)', async () => {
      const manager = new TargetPoolManager([adapter], fast);
      try {
        await manager.withConnection(viaProxy(), (c) => c.query(`SELECT 1 FROM DUAL`));
        await manager.withConnection(direct(), (c) => c.query(`SELECT 1 FROM DUAL`));
        expect(manager.stats('hung')).toMatchObject({ idle: 1 });

        proxy.freeze();
        const hung = manager.withConnection(viaProxy(), (c) => c.query(`SELECT 1 FROM DUAL`));
        const hungResult = hung.then(
          () => undefined,
          (e: unknown) => e,
        );
        await sleep(200);

        for (let i = 0; i < 20; i++) {
          const [, ms] = await timed(() =>
            manager.withConnection(direct(), (c) => c.query(`SELECT 1 FROM DUAL`)),
          );
          expect(ms).toBeLessThan(1_000);
        }

        expect(await hungResult).toMatchObject({ code: 'TARGET_TIMEOUT' });
        expect(manager.stats('hung')).toMatchObject({ idle: 0, inUse: 0 });
      } finally {
        proxy.thaw();
        await manager.closeAll();
      }
    });

    it('접속당 커넥션은 동시에 2개를 넘지 않고, 대기 제한을 넘으면 TARGET_BUSY', async () => {
      const user = await oracle.createUser('POOL_MAX', 'PoolMax_test1');
      const target: PoolTarget = {
        id: 'max',
        info: { ...info, username: user.user, password: user.password },
      };
      const manager = new TargetPoolManager([adapter], { acquireTimeoutMs: 1_500 });
      try {
        let peak = 0;
        const sleepers = Array.from({ length: 4 }, () =>
          manager.withConnection(target, (c) => c.execute(`BEGIN DBMS_SESSION.SLEEP(2); END;`)),
        );
        const settled = Promise.allSettled(sleepers);
        const sampler = (async () => {
          for (let i = 0; i < 6; i++) {
            peak = Math.max(peak, await sessionCount(user.user));
            await sleep(300);
          }
        })();
        const results = await settled;
        await sampler;

        expect(peak).toBeLessThanOrEqual(2);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
        for (const r of results.filter((x) => x.status === 'rejected')) {
          expect(r.reason).toMatchObject({ code: 'TARGET_BUSY' });
        }
      } finally {
        await manager.closeAll();
      }
    });

    it('유휴 60초가 지나면 커넥션을 닫는다', async () => {
      const user = await oracle.createUser('POOL_IDLE', 'PoolIdle_test1');
      const target: PoolTarget = {
        id: 'idle',
        info: { ...info, username: user.user, password: user.password },
      };
      // 기본값(유휴 60초)을 그대로 쓴다
      const manager = new TargetPoolManager([adapter]);
      try {
        await manager.withConnection(target, (c) => c.query(`SELECT 1 FROM DUAL`));
        expect(await sessionCount(user.user)).toBe(1);

        await sleep(55_000);
        expect(await sessionCount(user.user)).toBe(1);

        await waitFor(async () => (await sessionCount(user.user)) === 0, {
          timeoutMs: 10_000,
          intervalMs: 500,
          message: '유휴 커넥션 종료',
        });
        expect(manager.stats('idle')).toMatchObject({ idle: 0, inUse: 0 });
      } finally {
        await manager.closeAll();
      }
    }, 90_000);
  });
});
