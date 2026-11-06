import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import type { AuthProvider, Credentials, UserIdentity } from './auth-provider.js';
import { PasswordHasher } from './password-hasher.js';
import { UsersService } from './users.service.js';

const invalidCredentials = () =>
  new ApiError(
    HttpStatus.UNAUTHORIZED,
    'INVALID_CREDENTIALS',
    '아이디 또는 비밀번호가 맞지 않습니다',
  );

function accountLocked(lockedUntil: number, now: number): ApiError {
  const minutes = Math.max(1, Math.ceil((lockedUntil - now) / 60_000));
  return new ApiError(
    HttpStatus.LOCKED,
    'ACCOUNT_LOCKED',
    `로그인 실패가 반복돼 계정이 잠겼습니다. ${minutes}분 후 다시 시도하거나 관리자에게 비밀번호 초기화를 요청하세요`,
  );
}

/**
 * 로컬 계정 인증 (PRD FR-USR-01, FR-USR-04)
 *
 * - 없는 아이디, 비활성 계정, 틀린 비밀번호는 모두 같은 오류로 응답하고, 없는 아이디도 해시 비교를 거쳐 응답 시간을 맞춘다.
 * - 잠긴 계정은 비밀번호를 확인하지 않고 거부한다. 잠금 중 시도는 실패 횟수에 넣지 않는다.
 */
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  constructor(
    private readonly users: UsersService,
    private readonly hasher: PasswordHasher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async authenticate({ username, password }: Credentials): Promise<UserIdentity> {
    const user = this.users.findByUsername(username);
    if (!user) {
      await this.hasher.verifyDummy(password);
      throw invalidCredentials();
    }
    const now = this.clock();
    if (user.lockedUntil !== null && user.lockedUntil > now) {
      throw accountLocked(user.lockedUntil, now);
    }
    const ok = await this.hasher.verify(user.passwordHash, password);
    if (!user.isActive) throw invalidCredentials();
    if (!ok) {
      const lockedUntil = this.users.recordLoginFailure(user.id);
      throw lockedUntil === null ? invalidCredentials() : accountLocked(lockedUntil, now);
    }
    this.users.recordLoginSuccess(user.id);
    return { id: user.id, username: user.username, isAdmin: user.isAdmin };
  }
}
