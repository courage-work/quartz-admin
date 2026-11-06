import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { SchedulersController } from './schedulers.controller.js';

/** 접속·스케줄러 관리 (PRD FR-CON, TRD §5.7) */
@Module({
  controllers: [ConnectionsController, SchedulersController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
