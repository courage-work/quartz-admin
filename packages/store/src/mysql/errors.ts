import type { TargetConnectInfo } from '../adapter.js';
import {
  TargetError,
  classifyNodeNetError,
  redactConnectionInfo,
  stringProp,
  type TargetErrorCode,
} from '../errors.js';

/**
 * MySQL 서버 오류 번호(errno) 분류 (TRD §5.6).
 * https://dev.mysql.com/doc/mysql-errors/8.4/en/server-error-reference.html
 */
const ERRNO_MAP = new Map<number, TargetErrorCode>([
  [1044, 'TARGET_AUTH_FAILED'], // ER_DBACCESS_DENIED_ERROR: DB 접근 권한 없음
  [1045, 'TARGET_AUTH_FAILED'], // ER_ACCESS_DENIED_ERROR: 계정 또는 비밀번호
  [1049, 'TARGET_UNREACHABLE'], // ER_BAD_DB_ERROR: DB 이름이 없음(PostgreSQL 3D000과 같게 본다)
  [1040, 'TARGET_UNREACHABLE'], // ER_CON_COUNT_ERROR: 커넥션 수 초과
  [1053, 'TARGET_UNREACHABLE'], // ER_SERVER_SHUTDOWN
  [1927, 'TARGET_UNREACHABLE'], // ER_CONNECTION_KILLED
  [4031, 'TARGET_UNREACHABLE'], // ER_CLIENT_INTERACTION_TIMEOUT: 서버가 유휴 커넥션을 끊음
  [2002, 'TARGET_UNREACHABLE'], // CR_CONNECTION_ERROR
  [2003, 'TARGET_UNREACHABLE'], // CR_CONN_HOST_ERROR
  [2006, 'TARGET_UNREACHABLE'], // CR_SERVER_GONE_ERROR
  [2013, 'TARGET_UNREACHABLE'], // CR_SERVER_LOST
  [3024, 'TARGET_TIMEOUT'], // ER_QUERY_TIMEOUT: max_execution_time 초과
  [1317, 'TARGET_TIMEOUT'], // ER_QUERY_INTERRUPTED
  [1205, 'LOCK_TIMEOUT'], // ER_LOCK_WAIT_TIMEOUT: innodb_lock_wait_timeout 초과
  [3572, 'LOCK_TIMEOUT'], // ER_LOCK_NOWAIT
]);

/** `mysql2`가 errno 없이 던지는 코드 */
const CODE_MAP = new Map<string, TargetErrorCode>([
  ['PROTOCOL_SEQUENCE_TIMEOUT', 'TARGET_TIMEOUT'], // 드라이버 쪽 쿼리 시간 제한
  ['PROTOCOL_CONNECTION_LOST', 'TARGET_UNREACHABLE'],
  ['PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'TARGET_UNREACHABLE'],
  ['PROTOCOL_ENQUEUE_AFTER_QUIT', 'TARGET_UNREACHABLE'],
]);

/** 교착 감지로 트랜잭션 전체가 롤백됨. 다시 시도할 수 있다 */
const DEADLOCK = 1213;
/** 고유 키 중복 (`ER_DUP_ENTRY`) */
export const MYSQL_DUP_ENTRY = 'ER_DUP_ENTRY';

const DETAIL_MAX = 500;

function errnoOf(err: unknown): number | undefined {
  const errno = (err as { errno?: unknown } | null)?.errno;
  return typeof errno === 'number' ? errno : undefined;
}

/** mysql2 오류를 `TargetError`로 바꾼다. 이미 `TargetError`면 그대로 돌려준다 */
export function toMysqlTargetError(err: unknown, info: TargetConnectInfo): TargetError {
  if (err instanceof TargetError) return err;
  const raw = stringProp(err, 'message') ?? String(err);
  const code = stringProp(err, 'code');
  const errno = errnoOf(err);
  const mapped: TargetErrorCode =
    (errno !== undefined ? ERRNO_MAP.get(errno) : undefined) ??
    (code !== undefined ? CODE_MAP.get(code) : undefined) ??
    classifyNodeNetError(code) ??
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
  return new TargetError(mapped, {
    ...(code !== undefined
      ? { driverCode: code }
      : errno !== undefined
        ? { driverCode: String(errno) }
        : {}),
    detail,
    ...(errno === DEADLOCK ? { retryable: true } : {}),
  });
}
