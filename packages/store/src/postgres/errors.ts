import type { TargetConnectInfo } from '../adapter.js';
import {
  TargetError,
  classifyNodeNetError,
  redactConnectionInfo,
  stringProp,
  type TargetErrorCode,
} from '../errors.js';

/**
 * PostgreSQL SQLSTATE 분류 (TRD §5.6). 클래스(앞 두 글자)로 먼저 보고, 클래스 안에서 다르게 다룰 코드는 따로 둔다.
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const CODE_MAP = new Map<string, TargetErrorCode>([
  ['28000', 'TARGET_AUTH_FAILED'], // invalid_authorization_specification(pg_hba 거부 포함)
  ['28P01', 'TARGET_AUTH_FAILED'], // invalid_password
  ['3D000', 'TARGET_UNREACHABLE'], // invalid_catalog_name: DB 이름이 없음(Oracle 서비스 이름 미등록과 같게 본다)
  ['53300', 'TARGET_UNREACHABLE'], // too_many_connections
  ['57P01', 'TARGET_UNREACHABLE'], // admin_shutdown
  ['57P02', 'TARGET_UNREACHABLE'], // crash_shutdown
  ['57P03', 'TARGET_UNREACHABLE'], // cannot_connect_now(기동 중)
  ['57014', 'TARGET_TIMEOUT'], // query_canceled(statement_timeout)
  ['25P03', 'TARGET_TIMEOUT'], // idle_in_transaction_session_timeout
  ['55P03', 'LOCK_TIMEOUT'], // lock_not_available(lock_timeout)
]);

const CLASS_MAP = new Map<string, TargetErrorCode>([
  ['08', 'TARGET_UNREACHABLE'], // connection_exception
]);

/** 교착 감지로 트랜잭션이 롤백됨. 다시 시도할 수 있다 */
const DEADLOCK = '40P01';
/** 고유 제약 위반 */
export const PG_UNIQUE_VIOLATION = '23505';

const DETAIL_MAX = 500;

/** `pg`가 SQLSTATE 없이 던지는 연결·시간 초과 메시지 */
function classifyMessage(message: string): TargetErrorCode | undefined {
  if (/timeout expired|connection timeout|Query read timeout/i.test(message))
    return 'TARGET_TIMEOUT';
  if (
    /Connection terminated|Client has encountered a connection error|not queryable/i.test(message)
  ) {
    return 'TARGET_UNREACHABLE';
  }
  return undefined;
}

/** pg 오류를 `TargetError`로 바꾼다. 이미 `TargetError`면 그대로 돌려준다 */
export function toPostgresTargetError(err: unknown, info: TargetConnectInfo): TargetError {
  if (err instanceof TargetError) return err;
  const raw = stringProp(err, 'message') ?? String(err);
  const sqlState = stringProp(err, 'code');
  const isSqlState = sqlState !== undefined && /^[0-9A-Z]{5}$/.test(sqlState);
  const code: TargetErrorCode =
    (isSqlState ? (CODE_MAP.get(sqlState) ?? CLASS_MAP.get(sqlState.slice(0, 2))) : undefined) ??
    classifyNodeNetError(sqlState) ??
    classifyMessage(raw) ??
    'TARGET_ERROR';
  const detail = redactConnectionInfo(raw, {
    host: info.host,
    port: info.port,
    username: info.username,
    password: info.password,
    names: [info.database],
  })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX);
  return new TargetError(code, {
    ...(sqlState !== undefined ? { driverCode: sqlState } : {}),
    detail,
    ...(sqlState === DEADLOCK ? { retryable: true } : {}),
  });
}
