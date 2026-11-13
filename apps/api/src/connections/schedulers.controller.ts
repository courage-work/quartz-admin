import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  type DashboardQuery,
  dashboardQuerySchema,
  type DashboardResponse,
  type DeleteImpactDto,
  type SchedulerDetailDto,
  type SchedulerDto,
  type SchedulerMuteDto,
  type SchedulerMuteInput,
  schedulerMuteSchema,
  type SchedulerSettings,
  schedulerSettingsSchema,
  type SnapshotDto,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthedRequest } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ZodPipe } from '../common/zod.pipe.js';
import {
  activeMute,
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
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 대시보드 목록 (FR-VIEW-01). 스냅샷 캐시만 읽는다 */
  @Get()
  dashboard(@Query(new ZodPipe(dashboardQuerySchema)) query: DashboardQuery): DashboardResponse {
    return this.connections.dashboard(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): SchedulerDetailDto {
    return this.connections.schedulerDetail(id);
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

  /** 알림 음소거 (FR-ALT-10). 상태는 계속 기록하고 발송만 멈춘다 */
  @Put(':id/mute')
  async mute(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(schedulerMuteSchema)) body: SchedulerMuteInput,
  ): Promise<SchedulerMuteDto> {
    const row = await this.audit.run(
      this.muteEntry(req, id, 'scheduler.mute'),
      () => this.connections.mute(id, body.until),
      (updated) => ({ after: { mutedUntil: updated.mutedUntil } }),
    );
    return { mutedUntil: row.mutedUntil };
  }

  /** 음소거 해제. 음소거 중이 아니면 바꾸지 않는다 */
  @Delete(':id/mute')
  async unmute(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SchedulerMuteDto> {
    const row = await this.audit.run(
      this.muteEntry(req, id, 'scheduler.unmute'),
      () => this.connections.unmute(id),
      () => ({ after: { mutedUntil: null } }),
    );
    return { mutedUntil: activeMute(row, this.clock()) };
  }

  private muteEntry(req: AuthedRequest, id: number, action: 'scheduler.mute' | 'scheduler.unmute') {
    const current = this.connections.findScheduler(id);
    return {
      actor: actorOf(req),
      action,
      targetType: 'scheduler' as const,
      target: {
        id,
        schedName: current?.schedName ?? null,
        displayName: current?.displayName ?? null,
      },
      schedulerId: id,
      ...(current
        ? {
            connectionId: current.connectionId,
            before: { mutedUntil: activeMute(current, this.clock()) },
          }
        : {}),
    };
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
