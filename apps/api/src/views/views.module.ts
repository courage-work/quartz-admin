import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { SchedulerViewsController } from './scheduler-views.controller.js';
import { SchedulerViewsService } from './scheduler-views.service.js';

/** 스케줄러 조회 (TRD §8, PRD FR-VIEW) */
@Module({
  imports: [ConnectionsModule],
  controllers: [SchedulerViewsController],
  providers: [SchedulerViewsService],
})
export class ViewsModule {}
