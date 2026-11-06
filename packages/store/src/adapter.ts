import type { DbKind } from './db-kind.js';

/**
 * 대상 DB 접속 정보. 메타 저장소 `connections` 행에서 비밀번호를 복호화해 만든다 (TRD §3.2).
 * 이 값은 로그나 오류 메시지에 그대로 넣지 않는다.
 */
export interface TargetConnectInfo {
  kind: DbKind;
  host: string;
  port: number;
  username: string;
  password: string;
  /** PostgreSQL·MySQL·MariaDB의 DB 이름 */
  database?: string | undefined;
  /** Oracle 서비스 이름. `oracleSid`와 둘 중 하나만 쓴다 */
  oracleServiceName?: string | undefined;
  /** Oracle SID */
  oracleSid?: string | undefined;
}

/** 바인드 변수로 넘길 수 있는 값 */
export type BindValue = string | number | boolean | null | Buffer;

/** 행 하나. 키는 드라이버가 돌려준 컬럼 이름(Oracle은 따옴표 없는 별칭이 대문자) 그대로다 */
export type Row = Record<string, unknown>;

export interface QueryOptions {
  /** 이 쿼리만 실행 제한을 바꾼다. 없으면 커넥션 기본값(조회 제한 10초) */
  timeoutMs?: number;
}

/**
 * 대상 DB 커넥션 하나. 드라이버 차이는 어댑터가 감춘다.
 * 실패는 모두 `TargetError`로 던지며, 메시지에는 접속 정보가 없다.
 * 자동 커밋은 하지 않는다. 쓰기는 `commit()`이나 `rollback()`으로 끝낸다.
 */
export interface TargetConn {
  readonly kind: DbKind;
  /** 조회. `binds`는 `dialect.param(n)` 자리에 순서대로 들어간다 */
  query<R extends Row = Row>(
    sql: string,
    binds?: readonly BindValue[],
    options?: QueryOptions,
  ): Promise<R[]>;
  /** 쓰기·DDL·세션 설정. 바뀐 행 수를 돌려준다 */
  execute(sql: string, binds?: readonly BindValue[], options?: QueryOptions): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** 커밋하지 않은 변경이 있을 수 있는지. 풀에 돌려놓기 전에 확인한다 */
  readonly inTransaction: boolean;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** 연결 수립 제한(ms) */
  connectTimeoutMs: number;
  /** 커넥션의 기본 쿼리 실행 제한(ms) */
  queryTimeoutMs: number;
}

/** DB 종류 하나의 드라이버 어댑터. 커넥션을 하나씩 연다. 풀링은 `TargetPoolManager`가 맡는다 */
export interface DriverAdapter {
  readonly kind: DbKind;
  connect(info: TargetConnectInfo, options: ConnectOptions): Promise<TargetConn>;
}
