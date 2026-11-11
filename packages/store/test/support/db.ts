import oracledb from 'oracledb';
import type mysql from 'mysql2/promise';
import type pg from 'pg';
import type { StartedNetwork, StartedTestContainer } from 'testcontainers';
import type { TargetConnectInfo } from '../../src/adapter.js';
import type { DbKind } from '../../src/db-kind.js';
import type { QuartzDialect } from '../../src/dialect.js';
import { mariadbDialect, mysqlDialect } from '../../src/mysql/dialect.js';
import { oracleDialect } from '../../src/oracle/dialect.js';
import { postgresDialect } from '../../src/postgres/dialect.js';
import { MARIADB_VERSION, MYSQL_VERSION, startMysql, type MysqlFixture } from './mysql.js';
import { startOracle, type OracleFixture, type StartOracleOptions } from './oracle.js';
import { POSTGRES_VERSION, startPostgres, type PostgresFixture } from './postgres.js';

/**
 * 통합 테스트를 돌릴 DB. `QA_IT_DB`로 고른다(`oracle` 기본, `postgres`, `mysql`, `mariadb`). 버전은
 * `QA_IT_POSTGRES_VERSION`, `QA_IT_MYSQL_VERSION`, `QA_IT_MARIADB_VERSION`으로 바꾼다. 같은 테스트 파일이 모든 DB에서 그대로 돌도록 이 파일의 {@link TestConnection}과
 * {@link DbFixture}만 쓴다.
 */
export type TestDbKind = 'oracle' | 'postgres' | 'mysql' | 'mariadb';

const TEST_DB_KINDS: readonly TestDbKind[] = ['oracle', 'postgres', 'mysql', 'mariadb'];

export const TEST_DB: TestDbKind = TEST_DB_KINDS.includes(process.env.QA_IT_DB as TestDbKind)
  ? (process.env.QA_IT_DB as TestDbKind)
  : 'oracle';

/** MySQL 계열(MySQL, MariaDB). SQL과 드라이버가 같아 테스트 분기도 같다 */
export function isMysqlFamily(kind: TestDbKind): kind is 'mysql' | 'mariadb' {
  return kind === 'mysql' || kind === 'mariadb';
}

/** describe 제목에 붙이는 DB 이름 */
export const TEST_DB_LABEL =
  TEST_DB === 'postgres'
    ? `PostgreSQL ${POSTGRES_VERSION}`
    : TEST_DB === 'mysql'
      ? `MySQL ${MYSQL_VERSION}`
      : TEST_DB === 'mariadb'
        ? `MariaDB ${MARIADB_VERSION}`
        : 'Oracle Free 23';

export type Binds = readonly unknown[] | Record<string, unknown>;

export interface ExecuteResult<T> {
  rows?: T[];
  rowsAffected?: number;
}

export interface ExecuteOptions {
  /** `object`면 행을 컬럼 이름(대문자) 객체로, 기본은 배열로 돌려준다 */
  outFormat?: 'array' | 'object';
}

/**
 * 검증·준비 SQL을 실행하는 테스트용 연결. oracledb `Connection`의 쓰는 부분과 같은 모양이다.
 *
 * - 바인드는 `:1`, `:2`…(또는 `:name`과 객체)로 쓴다. PostgreSQL에서는 `$1`로, MySQL에서는 나온 순서대로 `?`로 바꾼다
 * - 자동 커밋하지 않는다. DDL은 Oracle처럼 앞 트랜잭션을 커밋하고 바로 반영한다
 * - 테이블은 `quartzTableName`(따옴표 없는 대문자)으로 쓴다. PostgreSQL은 소문자로 접혀 Quartz 테이블과 맞는다
 */
export interface TestConnection {
  execute<T = unknown[]>(
    sql: string,
    binds?: Binds,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult<T>>;
  /** 같은 문장을 여러 행으로. PostgreSQL에서는 여러 행 VALUES로 묶어 보낸다 */
  executeMany(sql: string, rows: readonly (readonly unknown[])[]): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface DbCredentials {
  user: string;
  password: string;
}

export interface DbFixture {
  readonly kind: TestDbKind;
  /** 제품 쪽 DB 종류 */
  readonly dbKind: DbKind;
  readonly dialect: QuartzDialect;
  readonly container: StartedTestContainer;
  readonly network: StartedNetwork;
  readonly jdbcUrl: string;
  readonly user: string;
  readonly password: string;
  /** 앱 계정의 Quartz 테이블 스키마. Oracle은 계정 이름(대문자), PostgreSQL은 `public`, MySQL은 DB 이름 */
  readonly schema: string;
  /** 테스트 프로세스에서 제품 어댑터로 접속하는 정보 */
  targetInfo(credentials?: DbCredentials): TargetConnectInfo;
  connect(credentials?: DbCredentials): Promise<TestConnection>;
  withConnection<T>(
    fn: (conn: TestConnection) => Promise<T>,
    credentials?: DbCredentials,
  ): Promise<T>;
  /** 계정(Oracle) 또는 역할과 같은 이름의 스키마(PostgreSQL)를 만든다 */
  createUser(user: string, password: string): Promise<DbCredentials>;
  /** 테스트베드가 Quartz 2.5.x Oracle 23 BOOLEAN 스키마를 쓸 때의 드라이버 속성 */
  readonly oracle?: OracleFixture;
  readonly postgres?: PostgresFixture;
  readonly mysql?: MysqlFixture;
  stop(): Promise<void>;
}

export interface StartTestDbOptions {
  network?: StartedNetwork;
  oracle?: StartOracleOptions;
}

export async function startTestDb(options: StartTestDbOptions = {}): Promise<DbFixture> {
  const network = options.network ? { network: options.network } : {};
  if (isMysqlFamily(TEST_DB)) {
    return mysqlFixture(await startMysql({ ...network, flavor: TEST_DB }));
  }
  return TEST_DB === 'postgres'
    ? postgresFixture(await startPostgres(network))
    : oracleFixture(
        await startOracle({
          ...options.oracle,
          ...(options.network ? { network: options.network } : {}),
        }),
      );
}

// ── Oracle ───────────────────────────────────────────────────────

function wrapOracle(conn: oracledb.Connection): TestConnection {
  return {
    async execute<T>(sql: string, binds: Binds = [], options: ExecuteOptions = {}) {
      const result = await conn.execute<T>(sql, binds as oracledb.BindParameters, {
        outFormat:
          options.outFormat === 'object' ? oracledb.OUT_FORMAT_OBJECT : oracledb.OUT_FORMAT_ARRAY,
      });
      return {
        ...(result.rows ? { rows: result.rows } : {}),
        ...(result.rowsAffected !== undefined ? { rowsAffected: result.rowsAffected } : {}),
      };
    },
    async executeMany(sql, rows) {
      await conn.executeMany(sql, rows as unknown as oracledb.BindParameters[]);
    },
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    close: () => conn.close(),
  };
}

function oracleFixture(o: OracleFixture): DbFixture {
  const connect = async (c?: DbCredentials) => wrapOracle(await o.connect(c));
  return {
    kind: 'oracle',
    dbKind: 'oracle',
    dialect: oracleDialect,
    container: o.container,
    network: o.network,
    jdbcUrl: o.jdbcUrl,
    user: o.user,
    password: o.password,
    schema: o.user.toUpperCase(),
    oracle: o,
    targetInfo: (c = { user: o.user, password: o.password }) => ({
      kind: 'oracle',
      host: o.container.getHost(),
      port: o.container.getMappedPort(1521),
      username: c.user,
      password: c.password,
      oracleServiceName: 'FREEPDB1',
    }),
    connect,
    async withConnection(fn, c) {
      const conn = await connect(c);
      try {
        return await fn(conn);
      } finally {
        await conn.close();
      }
    },
    createUser: (user, password) => o.createUser(user, password),
    stop: () => o.stop(),
  };
}

// ── PostgreSQL ───────────────────────────────────────────────────

/**
 * `:1`·`:name` 바인드를 PostgreSQL `$1` 또는 MySQL `?`(나온 순서대로 값도 늘어놓음)로 바꾼다.
 * `::type` 캐스트와 문자열 안은 건드리지 않는다
 */
export function rewritePlaceholders(
  sql: string,
  binds: Binds,
  style: 'pg' | 'mysql',
): { text: string; values: unknown[] } {
  if (style === 'mysql') {
    const values: unknown[] = [];
    const text = scanPlaceholders(sql, (key) => {
      values.push(
        Array.isArray(binds)
          ? (binds as readonly unknown[])[Number(key) - 1]
          : (binds as Record<string, unknown>)[key],
      );
      return '?';
    });
    return { text, values };
  }
  return toPgPlaceholders(sql, binds);
}

/** 문자열 리터럴과 `::`를 건너뛰며 `:key`마다 `replace`의 결과로 바꾼다 */
function scanPlaceholders(sql: string, replace: (key: string) => string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === ':' && sql[i + 1] === ':') {
      out += '::';
      i += 2;
      continue;
    }
    const m = ch === ':' ? /^:([A-Za-z_]\w*|\d+)/.exec(sql.slice(i)) : null;
    if (m) {
      out += replace(m[1]!);
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `:1`·`:name` 바인드를 `$1`로 */
export function toPgPlaceholders(sql: string, binds: Binds): { text: string; values: unknown[] } {
  const named = !Array.isArray(binds);
  const values: unknown[] = named ? [] : [...(binds as readonly unknown[])];
  const order = new Map<string, number>();
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === ':' && sql[i + 1] === ':') {
      out += '::';
      i += 2;
      continue;
    }
    const m = ch === ':' ? /^:([A-Za-z_]\w*|\d+)/.exec(sql.slice(i)) : null;
    if (m) {
      const key = m[1]!;
      if (named) {
        let n = order.get(key);
        if (n === undefined) {
          values.push((binds as Record<string, unknown>)[key]);
          n = values.length;
          order.set(key, n);
        }
        out += `$${n}`;
      } else {
        out += `$${key}`;
      }
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, values };
}

const DDL = /^\s*(CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE)\b/i;
const PLAIN_SELECT = /^\s*SELECT\b/i;
const LOCKING = /\bFOR\s+UPDATE\b/i;

function upperKeys(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toUpperCase(), v]));
}

function wrapPostgres(client: pg.Client): TestConnection {
  let tx = false;
  const begin = async () => {
    if (!tx) {
      await client.query('BEGIN');
      tx = true;
    }
  };
  const self: TestConnection = {
    async execute<T>(sql: string, binds: Binds = [], options: ExecuteOptions = {}) {
      // Oracle 시험 문장 꼬리(`FOR UPDATE WAIT n`)는 PostgreSQL 문법으로
      const translated = sql.replace(/\bFOR\s+UPDATE\s+WAIT\s+\d+/i, 'FOR UPDATE');
      const { text, values } = toPgPlaceholders(translated, binds);
      if (DDL.test(text)) {
        if (tx) await self.commit();
      } else if (!PLAIN_SELECT.test(text) || LOCKING.test(text)) {
        await begin();
      }
      const result = await client.query({
        text,
        values,
        ...(options.outFormat === 'object' ? {} : { rowMode: 'array' as const }),
      });
      const rows = options.outFormat === 'object' ? result.rows.map(upperKeys) : result.rows;
      return { rows: rows as T[], rowsAffected: result.rowCount ?? 0 };
    },
    async executeMany(sql, rows) {
      // `VALUES (...)` 한 줄을 여러 줄로 늘려 500행씩 보낸다
      const match = /VALUES\s*(\([\s\S]*\))\s*$/i.exec(sql);
      if (!match) throw new Error(`executeMany는 INSERT ... VALUES (...) 문장만 받습니다: ${sql}`);
      const head = sql.slice(0, match.index);
      const tuple = match[1]!;
      await begin();
      for (let start = 0; start < rows.length; start += 500) {
        const chunk = rows.slice(start, start + 500);
        const values: unknown[] = [];
        const tuples = chunk.map((row) => {
          const base = values.length;
          values.push(...row);
          return tuple.replace(/:(\d+)/g, (_m, n: string) => `$${base + Number(n)}`);
        });
        await client.query(`${head}VALUES ${tuples.join(', ')}`, values);
      }
    },
    async commit() {
      if (tx) await client.query('COMMIT');
      tx = false;
    },
    async rollback() {
      if (tx) await client.query('ROLLBACK');
      tx = false;
    },
    close: () => client.end(),
  };
  return self;
}

function postgresFixture(p: PostgresFixture): DbFixture {
  const connect = async (c?: DbCredentials) => wrapPostgres(await p.connect(c));
  return {
    kind: 'postgres',
    dbKind: 'postgresql',
    dialect: postgresDialect,
    container: p.container,
    network: p.network,
    jdbcUrl: p.jdbcUrl,
    user: p.user,
    password: p.password,
    schema: 'public',
    postgres: p,
    targetInfo: (c = { user: p.user, password: p.password }) => ({
      kind: 'postgresql',
      host: p.host,
      port: p.port,
      username: c.user,
      password: c.password,
      database: p.database,
    }),
    connect,
    async withConnection(fn, c) {
      const conn = await connect(c);
      try {
        return await fn(conn);
      } finally {
        await conn.close();
      }
    },
    createUser: (user, password) => p.createUser(user.toLowerCase(), password),
    stop: () => p.stop(),
  };
}

// ── MySQL ────────────────────────────────────────────────────────

const SESSION_SET = /^\s*SET\s/i;

function wrapMysql(conn: mysql.Connection): TestConnection {
  let tx = false;
  const begin = async () => {
    if (!tx) {
      await conn.query('START TRANSACTION');
      tx = true;
    }
  };
  const self: TestConnection = {
    async execute<T>(sql: string, binds: Binds = [], options: ExecuteOptions = {}) {
      const translated = sql.replace(/\bFOR\s+UPDATE\s+WAIT\s+\d+/i, 'FOR UPDATE');
      const { text, values } = rewritePlaceholders(translated, binds, 'mysql');
      if (DDL.test(text)) {
        // MySQL은 DDL 앞에서 스스로 커밋한다
        tx = false;
      } else if (!SESSION_SET.test(text) && (!PLAIN_SELECT.test(text) || LOCKING.test(text))) {
        await begin();
      }
      const [result] = await conn.query({
        sql: text,
        values,
        ...(options.outFormat === 'object' ? {} : { rowsAsArray: true }),
      });
      if (Array.isArray(result)) {
        const rows =
          options.outFormat === 'object'
            ? (result as Record<string, unknown>[]).map(upperKeys)
            : (result as unknown[]);
        return { rows: rows as T[], rowsAffected: 0 };
      }
      return { rowsAffected: (result as { affectedRows?: number }).affectedRows ?? 0 };
    },
    async executeMany(sql, rows) {
      const match = /VALUES\s*(\([\s\S]*\))\s*$/i.exec(sql);
      if (!match) throw new Error(`executeMany는 INSERT ... VALUES (...) 문장만 받습니다: ${sql}`);
      const head = sql.slice(0, match.index);
      const tuple = match[1]!;
      await begin();
      for (let start = 0; start < rows.length; start += 500) {
        const chunk = rows.slice(start, start + 500);
        const values: unknown[] = [];
        const tuples = chunk.map((row) =>
          tuple.replace(/:(\d+)/g, (_m, n: string) => {
            values.push(row[Number(n) - 1]);
            return '?';
          }),
        );
        await conn.query(`${head}VALUES ${tuples.join(', ')}`, values);
      }
    },
    async commit() {
      if (tx) await conn.query('COMMIT');
      tx = false;
    },
    async rollback() {
      if (tx) await conn.query('ROLLBACK');
      tx = false;
    },
    close: () => conn.end(),
  };
  return self;
}

function mysqlFixture(m: MysqlFixture): DbFixture {
  const connect = async (c?: DbCredentials) => wrapMysql(await m.connect(c));
  return {
    kind: m.flavor,
    dbKind: m.flavor,
    dialect: m.flavor === 'mariadb' ? mariadbDialect : mysqlDialect,
    container: m.container,
    network: m.network,
    jdbcUrl: m.jdbcUrl,
    user: m.user,
    password: m.password,
    schema: m.database,
    mysql: m,
    targetInfo: (c = { user: m.user, password: m.password }) => ({
      kind: m.flavor,
      host: m.host,
      port: m.port,
      username: c.user,
      password: c.password,
      database: m.database,
    }),
    connect,
    async withConnection(fn, c) {
      const conn = await connect(c);
      try {
        return await fn(conn);
      } finally {
        await conn.close();
      }
    },
    createUser: (user, password) => m.createUser(user.toLowerCase(), password),
    stop: () => m.stop(),
  };
}

/**
 * Quartz `TRIGGER_ACCESS` 잠금 행이 풀려 있는지(부록 A.1 공통 사후 조건). 클러스터 노드가 잠깐씩 잡으므로 `waitSec`까지 기다린다.
 * Oracle은 `FOR UPDATE WAIT n`, PostgreSQL은 `SET LOCAL lock_timeout`으로 기다린다. 끝나면 ROLLBACK한다.
 */
export async function triggerAccessIsFree(
  conn: TestConnection,
  db: Pick<DbFixture, 'kind'>,
  schedName: string,
  locksTable: string,
  waitSec = 3,
): Promise<boolean> {
  try {
    if (db.kind === 'postgres') {
      await conn.execute(`SET LOCAL lock_timeout = '${waitSec}s'`);
    } else if (isMysqlFamily(db.kind)) {
      await conn.execute(`SET SESSION innodb_lock_wait_timeout = ${waitSec}`);
    }
    await conn.execute(
      `SELECT LOCK_NAME FROM ${locksTable} WHERE SCHED_NAME = :1 AND LOCK_NAME = 'TRIGGER_ACCESS' ` +
        (db.kind === 'oracle' ? `FOR UPDATE WAIT ${waitSec}` : 'FOR UPDATE'),
      [schedName],
    );
    return true;
  } catch (err) {
    // Oracle 23 ORA-00054, 이전 ORA-30006 / PostgreSQL 55P03 lock_not_available / MySQL 1205 ER_LOCK_WAIT_TIMEOUT
    const code = (err as { code?: unknown }).code;
    if (
      /ORA-(30006|00054)/.test(String(err)) ||
      code === '55P03' ||
      code === 'ER_LOCK_WAIT_TIMEOUT'
    ) {
      return false;
    }
    throw err;
  } finally {
    await conn.rollback();
    if (isMysqlFamily(db.kind)) {
      await conn.execute('SET SESSION innodb_lock_wait_timeout = DEFAULT');
    }
  }
}
