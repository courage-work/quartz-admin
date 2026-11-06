/**
 * 인증과 사용자 관리 API의 요청 스키마와 응답 타입 (TRD §4.2, PRD FR-USR)
 */
import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;
/** argon2 입력 길이를 제한해 과도하게 긴 입력으로 CPU를 쓰게 하는 요청을 막는다 */
export const PASSWORD_MAX_LENGTH = 256;

/** 아이디는 앞뒤 공백을 지우고 소문자로 맞춘다. `Admin`과 `admin`을 다른 계정으로 만들지 않기 위해서다 */
export const usernameSchema = z
  .string({ error: '아이디를 입력하세요' })
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._@-]{3,64}$/, {
    error: '아이디는 영문, 숫자, ., _, @, -로 된 3~64자여야 합니다',
  });

export const passwordSchema = z
  .string({ error: '비밀번호를 입력하세요' })
  .min(PASSWORD_MIN_LENGTH, { error: `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다` })
  .max(PASSWORD_MAX_LENGTH, { error: `비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하여야 합니다` });

/** 로그인은 형식 검사를 느슨하게 한다. 규칙을 알려주면 계정 추측에 도움이 되기 때문이다 */
export const loginRequestSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const createUserRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  isAdmin: z.boolean().default(false),
});
export type CreateUserRequest = z.input<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z.object({
  isActive: z.boolean(),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/** 로그인한 본인 정보 (`GET /auth/me`, `POST /auth/login` 응답) */
export interface MeResponse {
  id: number;
  username: string;
  isAdmin: boolean;
}

/** 사용자 관리 화면용. 비밀번호 해시는 포함하지 않는다 */
export interface UserDto {
  id: number;
  username: string;
  isAdmin: boolean;
  isActive: boolean;
  /** 로그인 실패로 잠긴 경우 해제 시각(epoch ms). 잠기지 않았으면 null */
  lockedUntil: number | null;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
}
