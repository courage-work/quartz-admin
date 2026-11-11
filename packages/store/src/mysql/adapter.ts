import mysql from 'mysql2/promise';
import type {
  BindValue,
  ConnectOptions,
  DriverAdapter,
  QueryOptions,
  Row,
  TargetConn,
  TargetConnectInfo,
} from '../adapter.js';
import { TargetError } from '../errors.js';
import { toMysqlTargetError } from './errors.js';

/** 드라이버 쪽 시간 제한. 서버의 `max_execution_time`이 먼저 동작하도록 1초 더 준다 */
const CLIENT_TIMEOUT_GRACE_MS = 1_000;

/** 트랜잭션이 필요한 조회. 잠금은 자동 커밋이면 문장이 끝나는 즉시 풀리므로 먼저 트랜잭션을 연다 */
const LOCKING_QUERY = /\bFOR\s+(UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i;
/** 세션 설정은 트랜잭션 밖에서 바로 반영한다(잠금 대기 제한 원복이 새 트랜잭션을 열지 않게) */
const SESSION_STATEMENT = /^\s*SET\s/i;

/**
 * dialect의 `:p1` 자리 표시를 SQL에 나온 순서대로 `?`로 바꾸고 값도 그 순서로 늘어놓는다.
 * MySQL의 `?`는 번호로 가리킬 수 없어, SQL 조각을 조립한 순서가 바인드 추가 순서와 달라도 값이 맞게 들어가도록 한다.
 * 같은 번호를 두 번 써도 된다.
 */
export function toMysqlPlaceholders(
  sql: string,
  binds: readonly BindValue[],
): { sql: string; values: BindValue[] } {
  const values: BindValue[] = [];
  const text = sql.replace(/:p(\d+)\b/g, (_m, n: string) => {
    const index = Number(n) - 1;
    if (index < 0 || index >= binds.length) {
      throw new TargetError('TARGET_ERROR', { detail: `바인드 :p${n}에 값이 없습니다` });
    }
    values.push(binds[index]!);
    return '?';
  });
  return { sql: text, values };
}

interface ResultHeader {
  affectedRows?: number;
}

/**
 * MySQL 커넥션. PostgreSQL 어댑터와 같이 쓰기(`execute`)와 잠금 조회 앞에서만 트랜잭션을 연다.
 * 세션 격리 수준은 접속할 때 READ COMMITTED로 맞춘다(MySQL 기본값은 REPEATABLE READ, TRD §5.3).
 *
 * UPDATE의 바뀐 행 수는 `FOUND_ROWS` 플래그로 "조건에 맞은 행 수"다. 값이 같아도 센다(다른 DB와 같음).
 * MySQL은 문장이 실패해도 트랜잭션을 유지하지만(교착은 예외), 호출자는 실패하면 ROLLBACK한다.
 */
class MysqlTargetConn implements TargetConn {
  readonly kind = 'mysql' as const;
  private tx = false;
  private broken = false;

  constructor(
    private readonly conn: mysql.Connection,
    private readonly info: TargetConnectInfo,
    private readonly defaultTimeoutMs: number,
  ) {
    conn.on('error', () => {
      this.broken = true;
    });
  }

  get inTransaction(): boolean {
    return this.tx;
  }

  async query<R extends Row = Row>(
    sql: string,
    binds: readonly BindValue[] = [],
    options: QueryOptions = {},
  ): Promise<R[]> {
    if (LOCKING_QUERY.test(sql)) await this.begin();
    const rows = await this.run(sql, binds, options);
    return rows as R[];
  }

  async execute(
    sql: string,
    binds: readonly BindValue[] = [],
    options: QueryOptions = {},
  ): Promise<number> {
    if (!SESSION_STATEMENT.test(sql)) await this.begin();
    const result = (await this.run(sql, binds, options)) as ResultHeader;
    return result.affectedRows ?? 0;
  }

  async commit(): Promise<void> {
    if (!this.tx) return;
    try {
      await this.run('COMMIT', []);
    } finally {
      this.tx = false;
    }
  }

  async rollback(): Promise<void> {
    if (!this.tx) return;
    try {
      await this.run('ROLLBACK', []);
    } finally {
      this.tx = false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.conn.end();
    } catch (err) {
      this.conn.destroy();
      throw toMysqlTargetError(err, this.info);
    }
  }

  private async begin(): Promise<void> {
    if (this.tx) return;
    await this.run('START TRANSACTION', []);
    this.tx = true;
  }

  private async run(
    sql: string,
    binds: readonly BindValue[],
    options: QueryOptions = {},
  ): Promise<unknown> {
    if (this.broken) {
      throw new TargetError('TARGET_UNREACHABLE', { detail: '서버와의 연결이 끊겼습니다' });
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const override = options.timeoutMs !== undefined && options.timeoutMs !== this.defaultTimeoutMs;
    const { sql: text, values } = toMysqlPlaceholders(sql, binds);
    try {
      if (override)
        await this.conn.query(
          `SET SESSION max_execution_time = ${Math.max(1, Math.round(timeoutMs))}`,
        );
      const [result] = await this.conn.query(
        { sql: text, timeout: timeoutMs + CLIENT_TIMEOUT_GRACE_MS },
        values,
      );
      return result;
    } catch (err) {
      const mapped = toMysqlTargetError(err, this.info);
      if (mapped.connectionBroken) this.broken = true;
      throw mapped;
    } finally {
      if (override && !this.broken) {
        await this.conn
          .query(`SET SESSION max_execution_time = ${this.defaultTimeoutMs}`)
          .catch(() => undefined);
      }
    }
  }
}

/**
 * MySQL 드라이버 어댑터 (`mysql2`, TRD §5.1, §5.2). 큰 정수는 안전한 범위면 number, DECIMAL도 number,
 * 날짜는 문자열, 시간대는 UTC로 받는다. 조회 제한은 세션 `max_execution_time`(SELECT에만 적용되는
 * `MAX_EXECUTION_TIME` 힌트와 같은 장치), 드라이버 쪽 쿼리 시간 제한, TCP keepalive를 쓴다.
 */
export class MysqlAdapter implements DriverAdapter {
  readonly kind = 'mysql' as const;

  async connect(info: TargetConnectInfo, options: ConnectOptions): Promise<TargetConn> {
    if (!info.database) {
      throw new TargetError('TARGET_ERROR', { message: '접속 정보에 DB 이름이 없습니다' });
    }
    let conn: mysql.Connection;
    try {
      conn = await mysql.createConnection({
        host: info.host,
        port: info.port,
        user: info.username,
        password: info.password,
        database: info.database,
        connectTimeout: options.connectTimeoutMs,
        supportBigNumbers: true,
        bigNumberStrings: false,
        decimalNumbers: true,
        dateStrings: true,
        timezone: 'Z',
        charset: 'utf8mb4',
        enableKeepAlive: true,
        multipleStatements: false,
        flags: ['FOUND_ROWS'],
      });
    } catch (err) {
      throw toMysqlTargetError(err, info);
    }
    // 연결 뒤의 소켓 오류가 처리되지 않은 이벤트로 남지 않게 한다
    conn.on('error', () => undefined);
    try {
      await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.query(
        `SET SESSION max_execution_time = ${Math.max(1, Math.round(options.queryTimeoutMs))}`,
      );
    } catch (err) {
      conn.destroy();
      throw toMysqlTargetError(err, info);
    }
    return new MysqlTargetConn(conn, info, options.queryTimeoutMs);
  }
}
