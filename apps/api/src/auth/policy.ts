/** 인증 정책 상수 (TRD §4.2) */

/** 연속 로그인 실패가 이 횟수에 이르면 계정을 잠근다 */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60_000;

/** 세션 절대 만료. 유휴 만료는 `QA_SESSION_IDLE_MIN` */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;

/** 로그인 API의 IP별 요청 제한 */
export const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

export const SESSION_COOKIE = 'qa_sid';
