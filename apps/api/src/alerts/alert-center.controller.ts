import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  alertCenterQuerySchema,
  type AlertCenterPage,
  type AlertCenterQuery,
  type AlertSummaryDto,
  type DeliveryFailureDto,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentSession, type AuthedRequest } from '../auth/decorators.js';
import type { SessionContext } from '../auth/sessions.service.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AlertCenterService } from './alert-center.service.js';

/** 인앱 알림 센터 (PRD FR-ALT-07, TRD §9.4) */
@Controller('alerts')
export class AlertCenterController {
  constructor(
    private readonly center: AlertCenterService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(
    @CurrentSession() session: SessionContext,
    @Query(new ZodPipe(alertCenterQuerySchema)) query: AlertCenterQuery,
  ): AlertCenterPage {
    return this.center.list(session.user.id, query);
  }

  /** 화면이 30초마다 읽는다. 감사 기록을 남기지 않는다 */
  @Get('summary')
  summary(@CurrentSession() session: SessionContext): AlertSummaryDto {
    return this.center.summary(session.user.id);
  }

  @Get('delivery-failures')
  deliveryFailures(): { items: DeliveryFailureDto[] } {
    return { items: this.center.deliveryFailures() };
  }

  /** 읽음은 사용자마다 따로다. 감사 기록을 남기지 않는다 */
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  readAll(@CurrentSession() session: SessionContext): { changed: number } {
    return { changed: this.center.markAllRead(session.user.id) };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  read(@CurrentSession() session: SessionContext, @Param('id', ParseIntPipe) id: number): void {
    this.center.markRead(session.user.id, id);
  }

  @Post(':id/ack')
  @HttpCode(HttpStatus.OK)
  ack(
    @Req() req: AuthedRequest,
    @CurrentSession() session: SessionContext,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ changed: boolean }> {
    const alert = this.center.describe(id);
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'alert.ack',
        targetType: 'alert',
        target: alert ?? { id },
        ...(alert ? { schedulerId: alert.schedulerId } : {}),
      },
      () => this.center.ack(session.user.id, id),
      (r) => ({ after: { status: r.status, changed: r.changed } }),
    );
  }
}
