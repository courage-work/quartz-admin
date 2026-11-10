/**
 * API 오류 응답 형식과 오류 코드
 *
 * 모든 오류 응답 본문은 `ApiErrorBody`다. 화면은 `code`로 분기하고 `message`(한국어)를 그대로 보여준다.
 */

/**
 * 대상 DB(Quartz가 쓰는 DB)에 접근하다 생긴 오류 코드 (TRD §5.6). `@qa/store`가 드라이버 오류를 이 코드로 분류한다.
 * 메시지는 코드마다 고정된 한국어 문구이고, 드라이버 원문(접속 정보 포함 가능)은 넣지 않는다.
 */
export const TARGET_ERROR_CODES = [
  /** 호스트·포트·서비스에 닿지 못함, 또는 커넥션이 끊김 (502) */
  'TARGET_UNREACHABLE',
  /** 계정 인증 실패, 잠김, 만료, 접속 권한 없음 (502) */
  'TARGET_AUTH_FAILED',
  /** 연결 또는 쿼리가 실행 제한 시간을 넘김 (504) */
  'TARGET_TIMEOUT',
  /** 이 접속의 커넥션 2개가 모두 사용 중이고 대기 시간도 넘김 (503) */
  'TARGET_BUSY',
  /** 행 잠금 대기가 제한 시간을 넘김. 아무것도 바뀌지 않음 (409) */
  'LOCK_TIMEOUT',
  /** 그 밖의 대상 DB 오류. 교착 롤백 포함 (502) */
  'TARGET_ERROR',
] as const;
export type TargetErrorCode = (typeof TARGET_ERROR_CODES)[number];

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
  /** 이미 있는 접속 이름 (409) */
  'CONNECTION_NAME_TAKEN',
  /** 이미 등록된 스케줄러(같은 접속, prefix, SCHED_NAME) (409) */
  'SCHEDULER_ALREADY_REGISTERED',
  /** 고른 후보를 감지 결과에서 찾지 못함. 다시 감지한 뒤 고른다 (409) */
  'SCHEDULER_NOT_DETECTED',
  /** 본인 계정 비활성화처럼 허용하지 않는 변경 (409) */
  'OPERATION_NOT_ALLOWED',
  /** 읽기 전용 접속이거나 쓰기 권한을 확인하지 못한 접속이라 제어할 수 없음 (409, FR-CTL-00a) */
  'READ_ONLY',
  /** 실행 직전 대상 상태가 화면에서 본 상태와 다름. 본문 `current`에 최신 상태가 온다 (409, FR-CTL-00e) */
  'STATE_CONFLICT',
  /**
   * 일시정지된 그룹(또는 전체 일시정지) 안의 지난 트리거를 개별로 재개하려 함. Quartz와 같은 결과를 보장할 수 없어
   * 거부한다. 본문 `current`에 해당 트리거가 온다 (409, TRD §7.4)
   */
  'RESUME_IN_PAUSED_GROUP',
  /** 요청이 너무 많음 (429) */
  'RATE_LIMITED',
  /** 처리하지 못한 서버 오류 (500) */
  'INTERNAL_ERROR',
  ...TARGET_ERROR_CODES,
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  /** 검증 실패 시 필드별 원인 */
  details?: { path: string; message: string }[];
  /**
   * 제어 명령이 거부됐을 때 대상의 최신 상태. `STATE_CONFLICT`면 `CommandExpected`,
   * `RESUME_IN_PAUSED_GROUP`이면 해당 트리거 키 목록(`TriggerKey[]`)이다
   */
  current?: unknown;
}

/** CSRF 방어용 헤더 (TRD §4.3). 상태를 바꾸는 요청에 `1`로 붙인다 */
export const CSRF_HEADER = 'X-QA-Request';
