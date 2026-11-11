import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  channelInputSchema,
  type ChannelDto,
  type ChannelInput,
  type ChannelsResponse,
  type ChannelTestResult,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthedRequest } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ChannelsService, channelView } from './channels.service.js';

/** 알림 채널 관리와 테스트 발송 (PRD FR-ALT-07, TRD §9.4). 로그인한 사용자 모두 쓸 수 있다(PRD 권한 모델) */
@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(): ChannelsResponse {
    return { channels: this.channels.list(), smtpConfigured: this.channels.smtpConfigured };
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): ChannelDto {
    return this.channels.get(id);
  }

  @Post()
  create(
    @Req() req: AuthedRequest,
    @Body(new ZodPipe(channelInputSchema)) body: ChannelInput,
  ): Promise<ChannelDto> {
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'channel.create',
        targetType: 'channel',
        target: { type: body.type, name: body.name },
      },
      () => this.channels.create(body),
      (dto) => {
        const created = this.channels.require(dto.id);
        return {
          target: { id: dto.id, type: dto.type, name: dto.name },
          after: channelView(created.row, created.config),
        };
      },
    );
  }

  @Put(':id')
  update(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(channelInputSchema)) body: ChannelInput,
  ): Promise<ChannelDto> {
    const current = this.channels.find(id);
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'channel.update',
        targetType: 'channel',
        target: { id, type: current?.row.type ?? body.type, name: current?.row.name ?? body.name },
        ...(current ? { before: channelView(current.row, current.config) } : {}),
      },
      () => this.channels.update(id, body),
      () => {
        const updated = this.channels.require(id);
        return { after: channelView(updated.row, updated.config) };
      },
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<void> {
    const current = this.channels.find(id);
    await this.audit.run(
      {
        actor: actorOf(req),
        action: 'channel.delete',
        targetType: 'channel',
        target: { id, type: current?.row.type ?? null, name: current?.row.name ?? null },
        ...(current ? { before: channelView(current.row, current.config) } : {}),
      },
      () => this.channels.delete(id),
      () => ({ after: { deleted: true } }),
    );
  }

  /** 예시 알림을 바로 보낸다. 실패해도 200으로 결과를 돌려준다 */
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  test(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ChannelTestResult> {
    const current = this.channels.find(id);
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'channel.test',
        targetType: 'channel',
        target: { id, type: current?.row.type ?? null, name: current?.row.name ?? null },
      },
      () => this.channels.test(id),
      (result) => ({ after: result }),
    );
  }
}
