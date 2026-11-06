import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController, LOGIN_RATE_LIMITER } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AUTH_PROVIDER } from './auth-provider.js';
import { CsrfGuard } from './csrf.guard.js';
import { LocalAuthProvider } from './local-auth.provider.js';
import { PasswordHasher } from './password-hasher.js';
import { LOGIN_RATE_LIMIT } from './policy.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import { SessionsService } from './sessions.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/** 인증, 세션, 사용자 관리 (TRD §4.2, §4.3) */
@Module({
  // 전역 모듈이지만 명시해 둔다. 미완료 감사 기록 정리가 초기 관리자 생성보다 먼저 돌아야 한다
  imports: [AuditModule],
  controllers: [AuthController, UsersController],
  providers: [
    PasswordHasher,
    SessionsService,
    UsersService,
    { provide: AUTH_PROVIDER, useClass: LocalAuthProvider },
    {
      provide: LOGIN_RATE_LIMITER,
      useFactory: () =>
        new FixedWindowRateLimiter(LOGIN_RATE_LIMIT.limit, LOGIN_RATE_LIMIT.windowMs),
    },
    // 등록 순서대로 실행된다: CSRF 검사 → 인증·권한
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionsService, UsersService],
})
export class AuthModule {}
