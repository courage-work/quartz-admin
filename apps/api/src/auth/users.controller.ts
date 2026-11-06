import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  type CreateUserRequest,
  createUserRequestSchema,
  type ResetPasswordRequest,
  resetPasswordRequestSchema,
  type UpdateUserRequest,
  updateUserRequestSchema,
  type UserDto,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AdminOnly, type AuthedRequest, CurrentSession } from './decorators.js';
import type { SessionContext } from './sessions.service.js';
import { UsersService } from './users.service.js';

/** 사용자 관리 API (PRD FR-USR-03, 관리자 전용). 변경은 모두 감사 로그에 남긴다 (FR-AUD-01) */
@AdminOnly()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(): UserDto[] {
    return this.users.list();
  }

  @Post()
  create(
    @Req() req: AuthedRequest,
    @Body(new ZodPipe(createUserRequestSchema)) body: Required<CreateUserRequest>,
  ): Promise<UserDto> {
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'user.create',
        targetType: 'user',
        target: { username: body.username },
      },
      () => this.users.create(body),
      (user) => ({
        target: { id: user.id, username: user.username },
        after: { isAdmin: user.isAdmin, isActive: user.isActive },
      }),
    );
  }

  /** 활성/비활성 전환 */
  @Patch(':id')
  update(
    @CurrentSession() session: SessionContext,
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ): Promise<UserDto> {
    const current = this.users.findById(id);
    return this.audit.run(
      {
        actor: actorOf(req),
        action: body.isActive ? 'user.activate' : 'user.deactivate',
        targetType: 'user',
        target: { id, username: current?.username ?? null },
        ...(current ? { before: { isActive: current.isActive } } : {}),
      },
      () => this.users.setActive(session.user.id, id, body.isActive),
      (user) => ({ after: { isActive: user.isActive } }),
    );
  }

  /** 비밀번호 초기화. 값은 남기지 않고 바뀌었다는 사실만 남긴다 (TRD §10) */
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(resetPasswordRequestSchema)) body: ResetPasswordRequest,
  ): Promise<void> {
    const current = this.users.findById(id);
    await this.audit.run(
      {
        actor: actorOf(req),
        action: 'user.password_reset',
        targetType: 'user',
        target: { id, username: current?.username ?? null },
      },
      () => this.users.resetPassword(id, body.password),
      () => ({ after: { passwordChanged: true } }),
    );
  }
}
