import pg from 'pg';
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
import { toPostgresTargetError } from './errors.js';

/** int8(BIGINT, `COUNT(*)`) */
const INT8_OID = 20;

/**
 * 풀(접속)마다 넘기는 타입 파서. int8을 문자열 대신 Number로 읽는다. 전역 `pg.types.setTypeParser`를 바꾸지 않는다
 * (같은 프로세스의 다른 pg 사용처에 영향을 주지 않기 위해, TRD §5.2). Quartz의 epoch ms와 개수는 2^53 미만이다.
 */
const TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === INT8_OID && format !== 'binary') return (value: string) => Number(value);
    return pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
  }) as pg.CustomTypesConfig['getTypeParser'],
};

/** 진행 중인 트랜잭션이 끊겨도 서버가 30초 뒤 정리한다 (TRD §5.2) */
const IDLE_IN_TRANSACTION_MS = 30_000;

/** 드라이버 쪽 시간 제한. 서버의 `statement_timeout`이 먼저 동작하도록 1초 더 준다 */
const CLIENT_TIMEOUT_GRACE_MS = 1_000;

/** 트랜잭션이 필요한 조회. 잠금은 트랜잭션 밖에서 문장이 끝나는 즉시 풀리므로 먼저 BEGIN한다 */
const LOCKING_QUERY = /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i;

/**
 * PostgreSQL 커넥션. `pg`는 문장마다 자동 커밋하므로, 다른 DB와 같은 "명시적으로 커밋할 때까지 반영하지 않음"을 맞추려고
 * 쓰기(`execute`)와 잠금 조회(`FOR UPDATE`) 앞에서 BEGIN한다. 잠그지 않는 조회는 자동 커밋으로 실행해
 * 트랜잭션을 열어 두지 않는다(유휴 트랜잭션을 만들지 않음).
 *
 * PostgreSQL은 트랜잭션 안에서 문장 하나가 실패하면 트랜잭션 전체가 중단된다. 호출자는 실패하면 ROLLBACK한다
 * (명령 실행, 권한 점검 모두 그렇게 짜여 있다).
 */
class PostgresTargetConn implements TargetConn {
  readonly kind = 'postgresql' as const;
  private tx = false;
  private broken = false;

  constructor(
    private readonly client: pg.Client,
    private readonly info: TargetConnectInfo,
    private readonly defaultTimeoutMs: number,
  ) {
    // 유휴 중 서버가 끊으면 다음 사용에서 TARGET_UNREACHABLE로 실패하고 풀이 버린다
    client.on('error', () => {
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
    const result = await this.run<R>(sql, binds, options);
    return result.rows;
  }

  async execute(
    sql: string,
    binds: readonly BindValue[] = [],
    options: QueryOptions = {},
  ): Promise<number> {
    await this.begin();
    const result = await this.run(sql, binds, options);
    return result.rowCount ?? 0;
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
      await this.client.end();
    } catch (err) {
      throw toPostgresTargetError(err, this.info);
    }
  }

  private async begin(): Promise<void> {
    if (this.tx) return;
    await this.run('BEGIN', []);
    this.tx = true;
  }

  private async run<R extends Row = Row>(
    sql: string,
    binds: readonly BindValue[],
    options: QueryOptions = {},
  ): Promise<pg.QueryResult<R>> {
    if (this.broken) {
      throw new TargetError('TARGET_UNREACHABLE', { detail: '서버와의 연결이 끊겼습니다' });
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const override = options.timeoutMs !== undefined && options.timeoutMs !== this.defaultTimeoutMs;
    try {
      if (override)
        await this.client.query(`SET statement_timeout = ${Math.max(1, Math.round(timeoutMs))}`);
      return await this.client.query<R>({
        text: sql,
        values: [...binds],
        query_timeout: timeoutMs + CLIENT_TIMEOUT_GRACE_MS,
      } as pg.QueryConfig);
    } catch (err) {
      throw toPostgresTargetError(err, this.info);
    } finally {
      if (override) {
        await this.client
          .query(`SET statement_timeout = ${this.defaultTimeoutMs}`)
          .catch(() => undefined);
      }
    }
  }
}

/**
 * PostgreSQL 드라이버 어댑터 (`pg`, TRD §5.1, §5.2). 서버 쪽 `statement_timeout`(조회 제한)과
 * `idle_in_transaction_session_timeout`(30초), TCP keepalive를 켠다.
 */
export class PostgresAdapter implements DriverAdapter {
  readonly kind = 'postgresql' as const;

  async connect(info: TargetConnectInfo, options: ConnectOptions): Promise<TargetConn> {
    if (!info.database) {
      throw new TargetError('TARGET_ERROR', { message: '접속 정보에 DB 이름이 없습니다' });
    }
    const client = new pg.Client({
      host: info.host,
      port: info.port,
      user: info.username,
      password: info.password,
      database: info.database,
      connectionTimeoutMillis: options.connectTimeoutMs,
      statement_timeout: options.queryTimeoutMs,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS,
      keepAlive: true,
      application_name: 'quartz-admin',
      types: TYPES,
    });
    // 연결 전에 난 소켓 오류가 처리되지 않은 이벤트로 남지 않게 한다
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      await client.end().catch(() => undefined);
      throw toPostgresTargetError(err, info);
    }
    return new PostgresTargetConn(client, info, options.queryTimeoutMs);
  }
}
