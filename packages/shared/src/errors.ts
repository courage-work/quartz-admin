/**
 * API 오류 응답 형식과 오류 코드
 *
 * 모든 오류 응답 본문은 `ApiErrorBody`다. 화면은 `code`로 분기하고 `message`(한국어)를 그대로 보여준다.
 */

export const API_ERROR_CODES = [
  /** 요청 본문·쿼리가 스키마와 맞지 않음 (400) */
  'VALIDATION_FAILED',
  /** 로그인하지 않았거나 세션이 만료됨 (401) */
  'UNAUTHENTICATED',
  /** 아이디 또는 비밀번호가 틀림. 계정 존재 여부는 알려주지 않는다 (401) */
  'INVALID_CREDENTIALS',
  /** 로그인 실패가 반복돼 계정이 잠김 (423) */
  'ACCOUNT_LOCKED',
  /** 현재 비밀번호 확인 실패 (400) */
  'WRONG_PASSWORD',
  /** 관리자 권한이 필요함 (403) */
  'FORBIDDEN',
  /** Origin 또는 `X-QA-Request` 헤더 검사 실패 (403) */
  'CSRF_REJECTED',
  /** 대상을 찾을 수 없음 (404) */
  'NOT_FOUND',
  /** 이미 있는 아이디 (409) */
  'USERNAME_TAKEN',
  /** 본인 계정 비활성화처럼 허용하지 않는 변경 (409) */
  'OPERATION_NOT_ALLOWED',
  /** 요청이 너무 많음 (429) */
  'RATE_LIMITED',
  /** 처리하지 못한 서버 오류 (500) */
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  /** 검증 실패 시 필드별 원인 */
  details?: { path: string; message: string }[];
}

/** CSRF 방어용 헤더 (TRD §4.3). 상태를 바꾸는 요청에 `1`로 붙인다 */
export const CSRF_HEADER = 'X-QA-Request';
