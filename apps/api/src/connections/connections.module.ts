import { Module } from '@nestjs/common';
import { AlertsController } from '../alerts/alerts.controller.js';
import { AlertsModule } from '../alerts/alerts.module.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { SchedulersController } from './schedulers.controller.js';

/** 접속·스케줄러 관리 (PRD FR-CON, TRD §5.7)와 스케줄러의 알림 규칙 (FR-ALT-06) */
@Module({
  imports: [AlertsModule],
  controllers: [ConnectionsController, SchedulersController, AlertsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
