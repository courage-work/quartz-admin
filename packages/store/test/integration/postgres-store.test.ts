import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresAdapter,
  TargetPoolManager,
  postgresDialect,
  queryDbNowMillis,
  type PoolTarget,
  type TargetConn,
  type TargetConnectInfo,
} from '../../src/index.js';
import {
  POSTGRES_VERSION,
  TEST_DB,
  startPostgres,
  startTcpProxy,
  type PostgresFixture,
} from '../support/index.js';

const queryOptions = { connectTimeoutMs: 10_000, queryTimeoutMs: 10_000 };

/**
 * PostgreSQL 어댑터 (B-27, TRD §5.2, §5.3). 타입 매핑, 트랜잭션 경계(쓰기·잠금 조회만 BEGIN), 서버 쪽 시간 제한,
 * 잠금 대기 제한, 오류 분류를 실제 서버로 확인한다. `QA_IT_DB=postgres`일 때만 돈다.
 */
describe.skipIf(TEST_DB !== 'postgres')(
  `@qa/store PostgreSQL 어댑터 (PostgreSQL ${POSTGRES_VERSION})`,
  () => {
    let pgdb: PostgresFixture;
    let info: TargetConnectInfo;
    const adapter = new PostgresAdapter();

    beforeAll(async () => {
      pgdb = await startPostgres();
      info = {
        kind: 'postgresql',
        host: pgdb.host,
        port: pgdb.port,
        username: pgdb.user,
        password: pgdb.password,
        database: pgdb.database,
      };
      const admin = await pgdb.connect();
      try {
        await admin.query(
          `CREATE TABLE qa_probe (id BIGINT PRIMARY KEY, flag BOOL, data BYTEA, label VARCHAR(20))`,
        );
        await admin.query(
          `INSERT INTO qa_probe VALUES (1, true, '\\x0102'::bytea, 'one'), (2, false, NULL, 'two')`,
        );
      } finally {
        await admin.end();
      }
    });

    afterAll(async () => {
      await pgdb?.stop();
    });

    async function withConn<T>(
      fn: (conn: TargetConn) => Promise<T>,
      i = info,
      options = queryOptions,
    ): Promise<T> {
      const conn = await adapter.connect(i, options);
      try {
        return await fn(conn);
      } finally {
        await conn.close();
      }
    }

    describe('어댑터', () => {
      it('행은 별칭 그대로의 객체, BIGINT·COUNT(*)는 number, BYTEA는 Buffer, BOOL은 boolean', async () => {
        const rows = await withConn((c) =>
          c.query(
            `SELECT id AS "ID", flag AS "F", data AS "D", label AS "L", COUNT(*) OVER () AS "CNT" ` +
              `FROM qa_probe ORDER BY id`,
          ),
        );
        expect(rows).toEqual([
          { ID: 1, F: true, D: Buffer.from([1, 2]), L: 'one', CNT: 2 },
          { ID: 2, F: false, D: null, L: 'two', CNT: 2 },
        ]);
      });

      it('세션에 조회 제한(statement_timeout)과 유휴 트랜잭션 제한(30초)을 건다', async () => {
        const rows = await withConn((c) =>
          c.query(
            `SELECT current_setting('statement_timeout') AS "S", ` +
              `current_setting('idle_in_transaction_session_timeout') AS "I"`,
          ),
        );
        expect(rows).toEqual([{ S: '10s', I: '30s' }]);
      });

      it('잠그지 않는 조회는 트랜잭션을 열지 않고, 쓰기와 FOR UPDATE는 COMMIT·ROLLBACK까지 하나의 트랜잭션이다', async () => {
        await withConn(async (c) => {
          await c.query(`SELECT 1 AS "N"`);
          expect(c.inTransaction).toBe(false);
          expect(
            await c.execute(`UPDATE qa_probe SET label = $1 WHERE id = $2`, ['changed', 1]),
          ).toBe(1);
          expect(c.inTransaction).toBe(true);
          await c.rollback();
          expect(c.inTransaction).toBe(false);
          expect(await c.query(`SELECT label AS "L" FROM qa_probe WHERE id = 1`)).toEqual([
            { L: 'one' },
          ]);

          await c.query(`SELECT id FROM qa_probe WHERE id = 1 FOR UPDATE`);
          expect(c.inTransaction).toBe(true);
          await c.commit();
          expect(c.inTransaction).toBe(false);
        });
      });

      it('트랜잭션 안에서 실패하면 ROLLBACK 뒤 같은 커넥션을 다시 쓸 수 있다', async () => {
        await withConn(async (c) => {
          await c.execute(`UPDATE qa_probe SET label = 'x' WHERE id = 1`);
          await expect(c.execute(`INSERT INTO qa_probe (id) VALUES (1)`)).rejects.toMatchObject({
            code: 'TARGET_ERROR',
            driverCode: '23505',
          });
          await c.rollback();
          expect(await c.query(`SELECT label AS "L" FROM qa_probe WHERE id = 1`)).toEqual([
            { L: 'one' },
          ]);
        });
      });

      it('DB 현재 시각(ms)이 테스트 프로세스 시각과 가깝다', async () => {
        const now = await withConn((c) => queryDbNowMillis(c, postgresDialect));
        expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
      });

      it('LIMIT … OFFSET 페이지네이션이 동작한다', async () => {
        const rows = await withConn((c) =>
          c.query(
            postgresDialect.paginate(`SELECT id AS "ID" FROM qa_probe ORDER BY id`, 1, 2),
            [1, 1],
          ),
        );
        expect(rows).toEqual([{ ID: 2 }]);
      });

      it('lock_timeout을 넘기면 LOCK_TIMEOUT이고, 행은 바뀌지 않는다', async () => {
        const holder = await adapter.connect(info, queryOptions);
        try {
          await holder.query(`SELECT id FROM qa_probe WHERE id = 1 FOR UPDATE`);
          const started = Date.now();
          await withConn(async (c) => {
            await postgresDialect.beforeLockedTx(c, 1);
            await expect(
              c.query(`SELECT id FROM qa_probe WHERE id = 1 ${postgresDialect.forUpdate(1)}`),
            ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT', driverCode: '55P03' });
            await c.rollback();
          });
          expect(Date.now() - started).toBeLessThan(5_000);
        } finally {
          await holder.rollback();
          await holder.close();
        }
      });

      it('조회 제한을 넘기면 TARGET_TIMEOUT', async () => {
        await expect(
          withConn((c) => c.query(`SELECT pg_sleep(3)`), info, {
            ...queryOptions,
            queryTimeoutMs: 500,
          }),
        ).rejects.toMatchObject({ code: 'TARGET_TIMEOUT' });
      });

      it('틀린 비밀번호는 TARGET_AUTH_FAILED이고 메시지에 접속 정보가 없다', async () => {
        const err = await adapter.connect({ ...info, password: 'Wrong-pass1' }, queryOptions).then(
          () => null,
          (e: unknown) => e as Error & { detail?: string; code?: string },
        );
        expect(err).toMatchObject({ code: 'TARGET_AUTH_FAILED' });
        const text = `${err!.message} ${err!.detail ?? ''}`;
        expect(text).not.toContain(info.username);
        expect(text).not.toContain('Wrong-pass1');
        expect(text).not.toContain(String(info.port));
      });

      it('없는 DB와 닫힌 포트는 TARGET_UNREACHABLE', async () => {
        await expect(
          adapter.connect({ ...info, database: 'no_such_db' }, queryOptions),
        ).rejects.toMatchObject({ code: 'TARGET_UNREACHABLE', driverCode: '3D000' });
        await expect(adapter.connect({ ...info, port: 1 }, queryOptions)).rejects.toMatchObject({
          code: 'TARGET_UNREACHABLE',
        });
      });
    });

    describe('TargetPoolManager', () => {
      it('쿼리 도중 연결이 끊기면 TARGET_UNREACHABLE이고, 끊긴 커넥션은 버린 뒤 다시 연결한다', async () => {
        const proxy = await startTcpProxy(info.host, info.port);
        const pools = new TargetPoolManager([adapter]);
        const target: PoolTarget = {
          id: 'pg-proxied',
          info: { ...info, host: proxy.host, port: proxy.port },
        };
        try {
          expect(await pools.withConnection(target, (c) => c.query(`SELECT 1 AS "N"`))).toEqual([
            { N: 1 },
          ]);
          const pending = pools.withConnection(target, (c) => c.query(`SELECT pg_sleep(5)`));
          await new Promise((r) => setTimeout(r, 300));
          await proxy.close();
          await expect(pending).rejects.toMatchObject({ code: 'TARGET_UNREACHABLE' });
          // 프록시 없이 같은 접속(id) 정보를 바꾸면 새 풀로 다시 연결한다
          await pools.invalidate(target.id);
          expect(
            await pools.withConnection({ id: target.id, info }, (c) => c.query(`SELECT 2 AS "N"`)),
          ).toEqual([{ N: 2 }]);
        } finally {
          await pools.closeAll();
        }
      });
    });
  },
);
