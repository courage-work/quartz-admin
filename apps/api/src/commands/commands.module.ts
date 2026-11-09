import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { CommandsController } from './commands.controller.js';
import { QuartzCommandService } from './quartz-command.service.js';

/** 제어 명령 (TRD §7, PRD FR-CTL) */
@Module({
  imports: [ConnectionsModule],
  controllers: [CommandsController],
  providers: [QuartzCommandService],
  exports: [QuartzCommandService],
})
export class CommandsModule {}
