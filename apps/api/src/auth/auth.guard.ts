import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { forbidden, unauthenticated } from '../common/api-error.js';
import { ADMIN_ONLY, type AuthedRequest, IS_PUBLIC } from './decorators.js';
import { readSessionToken } from './session-cookie.js';
import { SessionsService } from './sessions.service.js';

/**
 * 전역 인증 가드. 기본은 로그인 필요이고, `@Public()`인 경로만 예외다.
 * 세션이 있으면 `req.auth`에 넣는다(`@Public()` 경로 포함).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = readSessionToken(req);
    const auth = token ? this.sessions.authenticate(token) : null;
    if (auth) req.auth = auth;

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (!auth) throw unauthenticated();
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets) && !auth.user.isAdmin) {
      throw forbidden();
    }
    return true;
  }
}
