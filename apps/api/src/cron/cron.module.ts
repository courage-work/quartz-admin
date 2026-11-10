import { Module } from '@nestjs/common';
import { CronController } from './cron.controller.js';

/** cron 미리보기와 타임존 목록 (TRD §7.6) */
@Module({ controllers: [CronController] })
export class CronModule {}
