import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MariadbAdapter,
  MysqlAdapter,
  mariadbDialect,
  mysqlDialect,
  queryDbNowMillis,
  type TargetConn,
  type TargetConnectInfo,
} from '../../src/index.js';
import {
  TEST_DB,
  TEST_DB_LABEL,
  isMysqlFamily,
  startMysql,
  type MysqlFixture,
} from '../support/index.js';

const queryOptions = { connectTimeoutMs: 10_000, queryTimeoutMs: 10_000 };

const flavor = TEST_DB === 'mariadb' ? 'mariadb' : 'mysql';
const dialect = flavor === 'mariadb' ? mariadbDialect : mysqlDialect;

/**
 * MySQL·MariaDB 어댑터 (B-28, B-29, TRD §5.2, §5.3). 타입 매핑, 자리 표시 변환, 트랜잭션 경계, 세션 설정(READ COMMITTED,
 * 시간 제한 변수), 잠금 대기 제한과 원복, 오류 분류를 실제 서버로 확인한다. `QA_IT_DB=mysql` 또는 `mariadb`일 때만 돈다.
 */
describe.skipIf(!isMysqlFamily(TEST_DB))(`@qa/store MySQL 계열 어댑터 (${TEST_DB_LABEL})`, () => {
  let my: MysqlFixture;
  let info: TargetConnectInfo;
  const adapter = flavor === 'mariadb' ? new MariadbAdapter() : new MysqlAdapter();

  beforeAll(async () => {
    my = await startMysql({ flavor });
    info = {
      kind: flavor,
      host: my.host,
      port: my.port,
      username: my.user,
      password: my.password,
      database: my.database,
    };
    const admin = await my.connect();
    try {
      await admin.query(
        `CREATE TABLE qa_probe (id BIGINT PRIMARY KEY, flag VARCHAR(1), data BLOB, label VARCHAR(20)) ENGINE=InnoDB`,
      );
      await admin.query(
        `INSERT INTO qa_probe VALUES (1, '1', X'0102', 'one'), (2, '0', NULL, 'two')`,
      );
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    await my?.stop();
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

  const p = (n: number) => dialect.param(n);

  describe('어댑터', () => {
    it('행은 별칭 그대로의 객체, BIGINT·COUNT(*)는 number, BLOB은 Buffer, VARCHAR(1) 불리언은 문자열', async () => {
      const rows = await withConn((c) =>
        c.query(
          'SELECT id AS `ID`, flag AS `F`, data AS `D`, label AS `L`, ' +
            '(SELECT COUNT(*) FROM qa_probe) AS `CNT` FROM qa_probe ORDER BY id',
        ),
      );
      expect(rows).toEqual([
        { ID: 1, F: '1', D: Buffer.from([1, 2]), L: 'one', CNT: 2 },
        { ID: 2, F: '0', D: null, L: 'two', CNT: 2 },
      ]);
    });

    it('dialect 자리 표시는 SQL에 나온 순서대로 들어간다(순서가 뒤바뀌거나 같은 번호를 다시 써도)', async () => {
      const rows = await withConn((c) =>
        c.query(`SELECT ${p(2)} AS \`A\`, ${p(1)} AS \`B\`, ${p(2)} AS \`C\``, ['one', 'two']),
      );
      expect(rows).toEqual([{ A: 'two', B: 'one', C: 'two' }]);
    });

    it('세션 격리 수준은 READ COMMITTED, 조회 제한은 MySQL max_execution_time(ms)·MariaDB max_statement_time(초)', async () => {
      // MariaDB 10.3에는 transaction_isolation 별칭이 없다
      const sql =
        flavor === 'mariadb'
          ? 'SELECT @@SESSION.tx_isolation AS `I`, @@SESSION.max_statement_time AS `M`'
          : 'SELECT @@SESSION.transaction_isolation AS `I`, @@SESSION.max_execution_time AS `M`';
      const rows = await withConn((c) => c.query(sql));
      expect(rows).toEqual([{ I: 'READ-COMMITTED', M: flavor === 'mariadb' ? 10 : 10_000 }]);
    });

    it('다른 계열 어댑터로 붙으면 DB 종류를 바꾸라고 안내한다', async () => {
      const other = flavor === 'mariadb' ? new MysqlAdapter() : new MariadbAdapter();
      const err = await other.connect({ ...info, kind: other.kind }, queryOptions).then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      );
      expect(err).toMatchObject({ code: 'TARGET_ERROR', driverCode: 'ER_UNKNOWN_SYSTEM_VARIABLE' });
      expect(err!.message).toContain(flavor === 'mariadb' ? 'MariaDB' : 'MySQL');
    });

    it('잠그지 않는 조회는 트랜잭션을 열지 않고, 쓰기와 FOR UPDATE는 COMMIT·ROLLBACK까지 하나의 트랜잭션이다', async () => {
      await withConn(async (c) => {
        await c.query('SELECT 1 AS `N`');
        expect(c.inTransaction).toBe(false);
        expect(
          await c.execute(`UPDATE qa_probe SET label = ${p(1)} WHERE id = ${p(2)}`, ['changed', 1]),
        ).toBe(1);
        expect(c.inTransaction).toBe(true);
        await c.rollback();
        expect(await c.query('SELECT label AS `L` FROM qa_probe WHERE id = 1')).toEqual([
          { L: 'one' },
        ]);
        await c.query('SELECT id FROM qa_probe WHERE id = 1 FOR UPDATE');
        expect(c.inTransaction).toBe(true);
        await c.commit();
        expect(c.inTransaction).toBe(false);
      });
    });

    it('UPDATE의 행 수는 값이 같아도 조건에 맞은 행 수다(FOUND_ROWS)', async () => {
      await withConn(async (c) => {
        expect(await c.execute(`UPDATE qa_probe SET label = 'one' WHERE id = 1`)).toBe(1);
        await c.rollback();
      });
    });

    it('고유 키 중복은 ER_DUP_ENTRY이고, ROLLBACK 뒤 같은 커넥션을 다시 쓸 수 있다', async () => {
      await withConn(async (c) => {
        await c.execute(`UPDATE qa_probe SET label = 'x' WHERE id = 1`);
        await expect(c.execute(`INSERT INTO qa_probe (id) VALUES (1)`)).rejects.toMatchObject({
          code: 'TARGET_ERROR',
          driverCode: 'ER_DUP_ENTRY',
        });
        await c.rollback();
        expect(await c.query('SELECT label AS `L` FROM qa_probe WHERE id = 1')).toEqual([
          { L: 'one' },
        ]);
      });
    });

    it('DB 현재 시각(ms)이 테스트 프로세스 시각과 가깝다', async () => {
      const now = await withConn((c) => queryDbNowMillis(c, dialect));
      expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
    });

    it('LIMIT … OFFSET 페이지네이션이 동작한다', async () => {
      const rows = await withConn((c) =>
        c.query(dialect.paginate('SELECT id AS `ID` FROM qa_probe ORDER BY id', 1, 2), [1, 1]),
      );
      expect(rows).toEqual([{ ID: 2 }]);
    });

    it('잠금 대기 제한을 넘기면 LOCK_TIMEOUT이고, 끝나면 세션 값을 기본값으로 되돌린다', async () => {
      const holder = await adapter.connect(info, queryOptions);
      try {
        await holder.query('SELECT id FROM qa_probe WHERE id = 1 FOR UPDATE');
        const started = Date.now();
        await withConn(async (c) => {
          await dialect.beforeLockedTx(c, 1);
          await expect(
            c.query(`SELECT id FROM qa_probe WHERE id = 1 ${dialect.forUpdate(1)}`),
          ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT', driverCode: 'ER_LOCK_WAIT_TIMEOUT' });
          await c.rollback();
          await dialect.afterLockedTx(c);
          expect(c.inTransaction).toBe(false);
          const [row] = await c.query('SELECT @@SESSION.innodb_lock_wait_timeout AS `W`');
          expect(row).toEqual({ W: 50 });
        });
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        await holder.rollback();
        await holder.close();
      }
    });

    it('조회 제한을 넘기면 TARGET_TIMEOUT', async () => {
      await expect(
        withConn(
          (c) =>
            c.query(
              'SELECT COUNT(*) AS `N` FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c',
            ),
          info,
          { ...queryOptions, queryTimeoutMs: 500 },
        ),
      ).rejects.toMatchObject({ code: 'TARGET_TIMEOUT' });
    });

    it('틀린 비밀번호는 TARGET_AUTH_FAILED이고 메시지에 접속 정보가 없다', async () => {
      const err = await adapter.connect({ ...info, password: 'Wrong-pass1' }, queryOptions).then(
        () => null,
        (e: unknown) => e as Error & { detail?: string },
      );
      expect(err).toMatchObject({ code: 'TARGET_AUTH_FAILED' });
      const text = `${err!.message} ${err!.detail ?? ''}`;
      expect(text).not.toContain(info.username);
      expect(text).not.toContain('Wrong-pass1');
    });

    it('없는 DB(전역 권한 계정)와 닫힌 포트는 TARGET_UNREACHABLE, 권한 없는 DB는 TARGET_AUTH_FAILED', async () => {
      await expect(
        adapter.connect(
          { ...info, username: my.root.user, password: my.root.password, database: 'no_such_db' },
          queryOptions,
        ),
      ).rejects.toMatchObject({ code: 'TARGET_UNREACHABLE', driverCode: 'ER_BAD_DB_ERROR' });
      // 권한이 없는 계정에는 DB가 있든 없든 접근 거부(1044)로 답한다
      await expect(
        adapter.connect({ ...info, database: 'no_such_db' }, queryOptions),
      ).rejects.toMatchObject({
        code: 'TARGET_AUTH_FAILED',
        driverCode: 'ER_DBACCESS_DENIED_ERROR',
      });
      await expect(adapter.connect({ ...info, port: 1 }, queryOptions)).rejects.toMatchObject({
        code: 'TARGET_UNREACHABLE',
      });
    });

    it.skipIf(flavor !== 'mariadb')(
      'MariaDB ed25519 인증 계정은 TARGET_AUTH_FAILED이고 지원하지 않는다고 안내한다',
      async () => {
        const root = await my.connectRoot();
        try {
          await root.query("INSTALL SONAME 'auth_ed25519'");
          // MariaDB 문서의 ed25519_password('secret') 값. 10.3에는 USING PASSWORD()가 없다
          await root.query(
            "CREATE USER 'ed_user'@'%' IDENTIFIED VIA ed25519 USING 'ZIgUREUg5PVgQ6LskhXmO+eZLS0nC8be6HPjYWR4YJY'",
          );
          await root.query("GRANT ALL ON quartz.* TO 'ed_user'@'%'");
        } finally {
          await root.end();
        }
        const err = await adapter
          .connect({ ...info, username: 'ed_user', password: 'secret' }, queryOptions)
          .then(
            () => null,
            (e: unknown) => e as Error & { code?: string },
          );
        expect(err).toMatchObject({
          code: 'TARGET_AUTH_FAILED',
          driverCode: 'AUTH_SWITCH_PLUGIN_ERROR',
        });
        expect(err!.message).toContain('ed25519');
        expect(err!.message).toContain('mysql_native_password');
      },
    );
  });
});
