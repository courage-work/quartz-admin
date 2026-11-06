import type { TargetConnectInfo } from '../adapter.js';
import {
  TargetError,
  classifyNodeNetError,
  redactConnectionInfo,
  stringProp,
  type TargetErrorCode,
} from '../errors.js';

const AUTH_FAILED = [
  'ORA-01004', // 기본 계정 로그인 거부
  'ORA-01005', // 비밀번호 없음
  'ORA-01017', // 계정 또는 비밀번호 틀림
  'ORA-01045', // CREATE SESSION 권한 없음
  'ORA-28000', // 계정 잠김
  'ORA-28001', // 비밀번호 만료
  'ORA-28040', // 인증 프로토콜 불일치
  'NJS-116', // Thin 모드가 지원하지 않는 비밀번호 검증자(10G)
];

const UNREACHABLE = [
  'NJS-500', // 커넥션 끊김
  'NJS-501',
  'NJS-503', // 연결 수립 실패
  'NJS-511', // 리스너 거부
  'NJS-518', // 서비스 이름 미등록
  'NJS-519', // SID 미등록
  'NJS-521', // 통신 중 EOF
  'NJS-530', // 호스트 이름 해석 실패
  'DPI-1080',
  'ORA-03113',
  'ORA-03114',
  'ORA-03135',
  'ORA-12505',
  'ORA-12514',
  'ORA-12519',
  'ORA-12520',
  'ORA-12526',
  'ORA-12528',
  'ORA-12537',
  'ORA-12541',
  'ORA-12543',
  'ORA-12545',
  'ORA-12547',
];

const TIMEOUT = [
  'NJS-510', // 연결 수립 시간 초과
  'NJS-123', // callTimeout 초과
  'DPI-1067',
  'ORA-01013', // callTimeout으로 취소됨
  'ORA-12170',
];

const LOCK_TIMEOUT = [
  'ORA-30006', // FOR UPDATE WAIT n 초과
  'ORA-00054', // NOWAIT 잠금 실패
];

const CODE_MAP = new Map<string, TargetErrorCode>([
  ...AUTH_FAILED.map((c) => [c, 'TARGET_AUTH_FAILED'] as const),
  ...UNREACHABLE.map((c) => [c, 'TARGET_UNREACHABLE'] as const),
  ...TIMEOUT.map((c) => [c, 'TARGET_TIMEOUT'] as const),
  ...LOCK_TIMEOUT.map((c) => [c, 'LOCK_TIMEOUT'] as const),
]);

/** 교착 감지로 문장이 롤백됨. 다시 시도할 수 있다 */
const DEADLOCK = 'ORA-00060';

const DETAIL_MAX = 500;

/** 드라이버 오류의 `ORA-01017` 같은 코드. `code` 속성이 없으면 메시지 앞에서 찾는다 */
function oracleCodeOf(err: unknown): string | undefined {
  const code = stringProp(err, 'code');
  if (code && /^(ORA|NJS|DPI)-\d+$/.test(code)) return code;
  const message = stringProp(err, 'message');
  return message?.match(/\b(ORA|NJS|DPI)-\d{3,5}\b/)?.[0] ?? code;
}

/** oracledb 오류를 `TargetError`로 바꾼다. 이미 `TargetError`면 그대로 돌려준다 */
export function toOracleTargetError(err: unknown, info: TargetConnectInfo): TargetError {
  if (err instanceof TargetError) return err;
  const driverCode = oracleCodeOf(err);
  const code: TargetErrorCode =
    (driverCode === undefined ? undefined : CODE_MAP.get(driverCode)) ??
    classifyNodeNetError(driverCode) ??
    'TARGET_ERROR';
  const raw = stringProp(err, 'message') ?? String(err);
  const detail = redactConnectionInfo(raw, {
    host: info.host,
    port: info.port,
    username: info.username,
    password: info.password,
    names: [info.oracleServiceName, info.oracleSid, info.database],
  })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX);
  return new TargetError(code, {
    driverCode,
    detail,
    ...(driverCode === DEADLOCK ? { retryable: true } : {}),
  });
}
