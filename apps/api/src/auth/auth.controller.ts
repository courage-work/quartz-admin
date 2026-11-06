import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  type ChangePasswordRequest,
  changePasswordRequestSchema,
  type LoginRequest,
  loginRequestSchema,
  type MeResponse,
} from '@qa/shared';
import type { Response } from 'express';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { AUTH_PROVIDER, type AuthProvider } from './auth-provider.js';
import { type AuthedRequest, CurrentSession, Public } from './decorators.js';
import { SESSION_COOKIE } from './policy.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import { readSessionToken, sessionCookieOptions } from './session-cookie.js';
import { type SessionContext, SessionsService, sessionIdOf } from './sessions.service.js';
import { UsersService } from './users.service.js';

export const LOGIN_RATE_LIMITER = Symbol('LOGIN_RATE_LIMITER');

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly authProvider: AuthProvider,
    @Inject(LOGIN_RATE_LIMITER) private readonly loginLimiter: FixedWindowRateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly sessions: SessionsService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodPipe(loginRequestSchema)) body: LoginRequest,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const retryAfter = this.loginLimiter.hit(req.ip ?? 'unknown', this.clock());
    if (retryAfter !== null) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        `로그인 시도가 너무 많습니다. ${retryAfter}초 후 다시 시도하세요`,
        undefined,
        { 'Retry-After': String(retryAfter) },
      );
    }
    let user: MeResponse;
    try {
      user = await this.authProvider.authenticate(body);
    } catch (err) {
      // 없는 아이디도 입력한 아이디로 남긴다. 속도 제한에 걸린 요청은 기록하지 않는다(기록이 무한히 쌓이지 않게)
      const known = this.users.findByUsername(body.username);
      this.audit.failure(
        {
          actor: actorOf(req, { id: known?.id ?? null, username: body.username }),
          action: 'auth.login',
        },
        err,
      );
      throw err;
    }

    // 이미 들고 있던 세션은 버리고 새로 발급한다
    const previous = readSessionToken(req);
    if (previous) this.sessions.revoke(sessionIdOf(previous));
    const token = this.sessions.create(user.id, {
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.get('user-agent') ? { userAgent: req.get('user-agent') } : {}),
    });
    this.audit.success({ actor: actorOf(req, user), action: 'auth.login' });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(this.config));
    return user;
  }

  /** 세션이 없거나 만료됐어도 쿠키는 지운다. 유효한 세션을 끝낸 경우만 기록한다 */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): void {
    const token = readSessionToken(req);
    if (token) this.sessions.revoke(sessionIdOf(token));
    if (req.auth) this.audit.success({ actor: actorOf(req), action: 'auth.logout' });
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.config));
  }

  @Get('me')
  me(@CurrentSession() session: SessionContext): MeResponse {
    return session.user;
  }

  /** 본인 비밀번호 변경 (FR-USR-05). 다른 기기의 세션은 끊긴다 */
  @Put('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentSession() session: SessionContext,
    @Req() req: AuthedRequest,
    @Body(new ZodPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
  ): Promise<void> {
    const { id, username } = session.user;
    await this.audit.run(
      {
        actor: actorOf(req),
        action: 'auth.password_change',
        targetType: 'user',
        target: { id, username },
      },
      () =>
        this.users.changeOwnPassword(id, session.sessionId, body.currentPassword, body.newPassword),
      // 값은 남기지 않고 바뀌었다는 사실만 남긴다 (TRD §10)
      () => ({ after: { passwordChanged: true } }),
    );
  }
}
