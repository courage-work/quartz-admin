import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  type CommandPreviewRequest,
  commandPreviewRequestSchema,
  type CommandPreviewResponse,
  type CommandRequest,
  commandRequestSchema,
  type CommandResultDto,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import type { AuthedRequest } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { QuartzCommandService } from './quartz-command.service.js';

/**
 * 제어 명령 API (TRD §7.1). 로그인한 사용자는 모두 쓸 수 있다(PRD 권한 모델).
 * 안전은 확인 대화상자(미리보기), 실행 직전 상태 재확인, 감사 로그로 확보한다.
 */
@Controller('schedulers/:id/commands')
export class CommandsController {
  constructor(private readonly commands: QuartzCommandService) {}

  /** 대상과 영향 범위. 대상 DB를 바꾸지 않는다 */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(commandPreviewRequestSchema)) body: CommandPreviewRequest,
  ): Promise<CommandPreviewResponse> {
    return this.commands.preview(id, body.command);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  execute(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(commandRequestSchema)) body: CommandRequest,
    @Req() req: AuthedRequest,
  ): Promise<CommandResultDto> {
    return this.commands.execute(id, body, actorOf(req));
  }
}
