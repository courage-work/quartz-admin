import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { unauthenticated } from '../common/api-error.js';
import type { SessionContext } from './sessions.service.js';

export const IS_PUBLIC = 'qa:isPublic';
export const ADMIN_ONLY = 'qa:adminOnly';

/** 로그인 없이 호출할 수 있는 경로. CSRF 검사는 그대로 적용된다 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 관리자만 호출할 수 있는 경로 (일반 사용자는 403) */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

export type AuthedRequest = Request & { auth?: SessionContext };

/** `AuthGuard`가 확인한 현재 세션 */
export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): SessionContext => {
    const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw unauthenticated();
    return auth;
  },
);
