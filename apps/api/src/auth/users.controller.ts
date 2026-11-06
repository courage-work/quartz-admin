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
import { ZodPipe } from '../common/zod.pipe.js';
import { AdminOnly, CurrentSession } from './decorators.js';
import type { SessionContext } from './sessions.service.js';
import { UsersService } from './users.service.js';

/** 사용자 관리 API (PRD FR-USR-03, 관리자 전용) */
@AdminOnly()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): UserDto[] {
    return this.users.list();
  }

  @Post()
  create(
    @Body(new ZodPipe(createUserRequestSchema)) body: Required<CreateUserRequest>,
  ): Promise<UserDto> {
    return this.users.create(body);
  }

  /** 활성/비활성 전환 */
  @Patch(':id')
  update(
    @CurrentSession() session: SessionContext,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(updateUserRequestSchema)) body: UpdateUserRequest,
  ): UserDto {
    return this.users.setActive(session.user.id, id, body.isActive);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(resetPasswordRequestSchema)) body: ResetPasswordRequest,
  ): Promise<void> {
    return this.users.resetPassword(id, body.password);
  }
}
