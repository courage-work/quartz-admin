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
  alertRuleInputSchema,
  type AlertRuleDto,
  type AlertRuleInput,
  type AlertRulesResponse,
  type SchedulerAlertsResponse,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthedRequest } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { AlertRulesService, alertRuleView } from './alert-rules.service.js';

/** 알림 규칙 관리와 스케줄러의 알림 목록 (PRD FR-ALT-06, TRD §9.2) */
@Controller()
export class AlertsController {
  constructor(
    private readonly rules: AlertRulesService,
    private readonly connections: ConnectionsService,
    private readonly audit: AuditService,
  ) {}

  @Get('schedulers/:id/alert-rules')
  list(@Param('id', ParseIntPipe) id: number): AlertRulesResponse {
    return { rules: this.rules.list(id) };
  }

  @Get('schedulers/:id/alerts')
  alerts(@Param('id', ParseIntPipe) id: number): SchedulerAlertsResponse {
    return this.rules.alerts(id);
  }

  @Post('schedulers/:id/alert-rules')
  create(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(alertRuleInputSchema)) body: AlertRuleInput,
  ): Promise<AlertRuleDto> {
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'alert_rule.create',
        targetType: 'alert_rule',
        target: { schedulerId: id, type: body.type },
        schedulerId: id,
        ...this.connectionOf(id),
      },
      () => this.rules.create(id, body),
      (rule) => ({
        target: { id: rule.id, schedulerId: id, type: rule.type },
        after: alertRuleView(rule),
      }),
    );
  }

  @Put('alert-rules/:id')
  update(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(alertRuleInputSchema)) body: AlertRuleInput,
  ): Promise<AlertRuleDto> {
    const current = this.rules.find(id);
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'alert_rule.update',
        targetType: 'alert_rule',
        target: { id, schedulerId: current?.schedulerId ?? null, type: current?.type ?? body.type },
        ...(current
          ? {
              schedulerId: current.schedulerId,
              ...this.connectionOf(current.schedulerId),
              before: alertRuleView(current),
            }
          : {}),
      },
      () => this.rules.update(id, body),
      (rule) => ({ after: alertRuleView(rule) }),
    );
  }

  @Delete('alert-rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<void> {
    const current = this.rules.find(id);
    await this.audit.run(
      {
        actor: actorOf(req),
        action: 'alert_rule.delete',
        targetType: 'alert_rule',
        target: { id, schedulerId: current?.schedulerId ?? null, type: current?.type ?? null },
        ...(current
          ? {
              schedulerId: current.schedulerId,
              ...this.connectionOf(current.schedulerId),
              before: alertRuleView(current),
            }
          : {}),
      },
      () => this.rules.delete(id),
      () => ({ after: { deleted: true } }),
    );
  }

  private connectionOf(schedulerId: number): { connectionId?: number } {
    const s = this.connections.findScheduler(schedulerId);
    return s ? { connectionId: s.connectionId } : {};
  }
}
