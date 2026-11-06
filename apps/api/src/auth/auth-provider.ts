import type { MeResponse } from '@qa/shared';

/**
 * 인증 계층 추상화 (TRD §4.2, PRD FR-USR-06)
 *
 * 지금은 로컬 계정(`LocalAuthProvider`)만 있다. 후속 릴리스의 OIDC SSO는 이 인터페이스의 다른 구현으로 붙인다.
 * 세션 발급과 권한 확인은 공급자와 무관하게 `SessionsService`와 가드가 맡는다.
 */
export interface Credentials {
  username: string;
  password: string;
}

/** 인증된 사용자. 세션과 감사 로그에 쓰는 최소 정보 */
export type UserIdentity = MeResponse;

export interface AuthProvider {
  /** 성공하면 사용자, 실패하면 `ApiError`(`INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`) */
  authenticate(credentials: Credentials): Promise<UserIdentity>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
