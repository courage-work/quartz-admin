import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
  Req,
} from '@nestjs/common';
import {
  type DeleteImpactDto,
  type SchedulerDto,
  type SchedulerSettings,
  schedulerSettingsSchema,
  type SnapshotDto,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthedRequest } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import {
  ConnectionsService,
  schedulerSettingsView,
  toSchedulerDto,
} from './connections.service.js';

/** 스케줄러 설정과 등록 해제 (PRD FR-CON-07, TRD §5.7). 조회 화면용 상세는 B-14·B-16에서 늘린다 */
@Controller('schedulers')
export class SchedulersController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): SchedulerDto {
    return toSchedulerDto(this.connections.requireScheduler(id));
  }

  /** 대시보드 캐시(감시 루프의 마지막 결과). 대상 DB를 조회하지 않는다 */
  @Get(':id/snapshot')
  snapshot(@Param('id', ParseIntPipe) id: number): { snapshot: SnapshotDto | null } {
    return { snapshot: this.connections.snapshot(id) };
  }

  @Put(':id/settings')
  async updateSettings(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(schedulerSettingsSchema)) body: SchedulerSettings,
  ): Promise<SchedulerDto> {
    const current = this.connections.findScheduler(id);
    const row = await this.audit.run(
      {
        actor: actorOf(req),
        action: 'scheduler.update',
        targetType: 'scheduler',
        target: { id, schedName: current?.schedName ?? null },
        schedulerId: id,
        ...(current
          ? { connectionId: current.connectionId, before: schedulerSettingsView(current) }
          : {}),
      },
      () => this.connections.updateSettings(id, body),
      (updated) => ({ after: schedulerSettingsView(updated) }),
    );
    return toSchedulerDto(row);
  }

  @Get(':id/delete-impact')
  deleteImpact(@Param('id', ParseIntPipe) id: number): DeleteImpactDto {
    return this.connections.schedulerDeleteImpact(id);
  }

  /** 등록 해제. 대상 DB의 Quartz 데이터는 건드리지 않는다 */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<void> {
    const current = this.connections.findScheduler(id);
    await this.audit.run(
      {
        actor: actorOf(req),
        action: 'scheduler.delete',
        targetType: 'scheduler',
        target: {
          id,
          schedName: current?.schedName ?? null,
          displayName: current?.displayName ?? null,
        },
        schedulerId: id,
        ...(current
          ? { connectionId: current.connectionId, before: schedulerSettingsView(current) }
          : {}),
      },
      () => this.connections.deleteScheduler(id),
      ({ impact }) => ({ after: { deleted: true, ...impact } }),
    );
  }
}
