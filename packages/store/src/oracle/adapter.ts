import oracledb from 'oracledb';
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
import { oracleConnectString } from './connect-string.js';
import { toOracleTargetError } from './errors.js';

/**
 * BLOB은 Lob 스트림 대신 Buffer로 받는다. 전역 `oracledb.fetchAsBuffer`를 바꾸지 않고 쿼리마다 넘긴다.
 * 같은 프로세스의 다른 oracledb 사용처(테스트 헬퍼 등)의 동작을 바꾸지 않기 위해서다.
 */
function fetchTypeHandler(
  metadata: oracledb.Metadata<unknown>,
): oracledb.FetchTypeResponse | undefined {
  return metadata.dbType === oracledb.DB_TYPE_BLOB ? { type: oracledb.BUFFER } : undefined;
}

const QUERY_OPTIONS: oracledb.ExecuteOptions = {
  outFormat: oracledb.OUT_FORMAT_OBJECT,
  fetchTypeHandler,
  autoCommit: false,
};

/**
 * 배열 바인드를 `{ p1, p2, … }` 이름 바인드로 바꾼다. `oracleDialect.param(n)`이 `:pn`을 만든다.
 * 이름으로 붙여야 SQL에 나온 순서와 상관없이 번호가 자리를 가리킨다.
 */
function namedBinds(binds: readonly BindValue[]): Record<string, BindValue> {
  const named: Record<string, BindValue> = {};
  binds.forEach((value, i) => {
    named[`p${i + 1}`] = value;
  });
  return named;
}

/** 드라이버 `callTimeout`이 동작할 시간을 준 뒤 JS 쪽에서 강제로 끝내기까지의 유예 */
const HARD_TIMEOUT_GRACE_MS = 1_000;

/** 쓰기·DDL 실행 옵션. 커밋은 호출자가 한다 */
const EXECUTE_OPTIONS: oracledb.ExecuteOptions = { autoCommit: false };

class OracleTargetConn implements TargetConn {
  readonly kind = 'oracle' as const;
  /** 드라이버가 `transactionInProgress`를 알려주지 않을 때 쓰는 추정값 */
  private wrote = false;

  constructor(
    private readonly conn: oracledb.Connection,
    private readonly info: TargetConnectInfo,
    private readonly defaultTimeoutMs: number,
  ) {}

  get inTransaction(): boolean {
    return this.conn.transactionInProgress ?? this.wrote;
  }

  async query<R extends Row = Row>(
    sql: string,
    binds: readonly BindValue[] = [],
    options: QueryOptions = {},
  ): Promise<R[]> {
    const result = await this.run(
      () => this.conn.execute<R>(sql, namedBinds(binds), QUERY_OPTIONS),
      options,
    );
    return result.rows ?? [];
  }

  async execute(
    sql: string,
    binds: readonly BindValue[] = [],
    options: QueryOptions = {},
  ): Promise<number> {
    this.wrote = true;
    const result = await this.run(
      () => this.conn.execute(sql, namedBinds(binds), EXECUTE_OPTIONS),
      options,
    );
    return result.rowsAffected ?? 0;
  }

  async commit(): Promise<void> {
    await this.run(() => this.conn.commit());
    this.wrote = false;
  }

  async rollback(): Promise<void> {
    await this.run(() => this.conn.rollback());
    this.wrote = false;
  }

  async close(): Promise<void> {
    await this.run(() => this.conn.close());
  }

  /**
   * 드라이버 호출 하나를 실행 제한 안에서 돌린다.
   *
   * 1차로 드라이버의 `callTimeout`을 쓴다. 하지만 Thin 모드는 시간이 지나면 서버에 중단 요청을 보내고
   * 그 응답을 기다리므로, 서버가 PL/SQL을 끝까지 실행하거나 네트워크가 멈추면 호출이 끝나지 않는다
   * (S3에서 확인). 그래서 제한 + 유예 시간이 지나면 드라이버 응답을 기다리지 않고 `TARGET_TIMEOUT`으로
   * 끝낸다. 이 커넥션은 끊긴 것으로 보고 풀이 버린다.
   */
  private async run<T>(fn: () => Promise<T>, options: QueryOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs;
    const override = timeoutMs !== undefined && timeoutMs !== this.defaultTimeoutMs;
    const limitMs = timeoutMs ?? this.defaultTimeoutMs;
    if (override) this.conn.callTimeout = timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const call = fn();
      // 강제로 끝낸 뒤 드라이버가 늦게 실패해도 처리되지 않은 rejection이 남지 않게 한다
      call.catch(() => undefined);
      const hardLimit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new TargetError('TARGET_TIMEOUT', {
              detail: `드라이버가 ${limitMs + HARD_TIMEOUT_GRACE_MS}ms 안에 응답하지 않았습니다`,
            }),
          );
        }, limitMs + HARD_TIMEOUT_GRACE_MS);
      });
      return await Promise.race([call, hardLimit]);
    } catch (err) {
      throw toOracleTargetError(err, this.info);
    } finally {
      clearTimeout(timer);
      if (override) {
        try {
          this.conn.callTimeout = this.defaultTimeoutMs;
        } catch {
          // 끊긴 커넥션에서는 속성 설정도 실패할 수 있다. 이 커넥션은 풀이 버린다
        }
      }
    }
  }
}

/**
 * Oracle 드라이버 어댑터. `oracledb` Thin 모드(Instant Client 불필요)로 연결한다 (TRD §5.1, §5.2).
 * NUMBER는 JS number로 받는다. Quartz의 epoch ms와 개수 컬럼은 2^53 미만이다.
 */
export class OracleAdapter implements DriverAdapter {
  readonly kind = 'oracle' as const;

  async connect(info: TargetConnectInfo, options: ConnectOptions): Promise<TargetConn> {
    const connectString = oracleConnectString(info);
    const timeoutSec = Math.max(1, Math.ceil(options.connectTimeoutMs / 1000));
    let conn: oracledb.Connection;
    try {
      conn = await oracledb.getConnection({
        user: info.username,
        password: info.password,
        connectString,
        // 둘 다 초 단위. connectTimeout은 TCP 연결부터 로그인까지, transportConnectTimeout은 TCP 연결만 센다
        connectTimeout: timeoutSec,
        transportConnectTimeout: timeoutSec,
        // 분 단위. 서버와의 연결이 살아 있는지 주기적으로 확인한다(TCP keepalive)
        expireTime: 1,
      });
    } catch (err) {
      throw toOracleTargetError(err, info);
    }
    try {
      conn.callTimeout = options.queryTimeoutMs;
    } catch (err) {
      await conn.close().catch(() => undefined);
      throw toOracleTargetError(err, info);
    }
    return new OracleTargetConn(conn, info, options.queryTimeoutMs);
  }
}
