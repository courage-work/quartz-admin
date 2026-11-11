import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { AlertCenterController } from './alert-center.controller.js';
import { AlertCenterService } from './alert-center.service.js';
import { AlertDefaults } from './alert-defaults.js';
import { AlertEngine } from './alert-engine.js';
import { AlertRulesService } from './alert-rules.service.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';
import {
  NOTIFIER_OPTIONS,
  NotificationWorker,
  type NotifierOptions,
} from './notification-worker.js';
import { SEND_TIMEOUT_MS, Senders } from './senders.js';

/**
 * 알림 규칙 엔진 (TRD §9.2, §9.3, B-24). 감시 루프의 확장 지점(`MonitorHooks`)에 엔진을 붙이고,
 * 접속 관리가 스케줄러를 등록할 때 쓰는 기본 규칙(`AlertDefaults`)을 내보낸다.
 * 발송(B-25): 채널 관리, 발송 큐 워커, 인앱 알림 센터.
 * 규칙 컨트롤러는 `ConnectionsService`가 필요해 접속 모듈에 둔다.
 */
@Module({
  controllers: [ChannelsController, AlertCenterController],
  providers: [
    AlertDefaults,
    AlertEngine,
    AlertRulesService,
    Senders,
    ChannelsService,
    AlertCenterService,
    {
      provide: NOTIFIER_OPTIONS,
      useFactory: (_config: AppConfig): NotifierOptions => ({
        enabled: true,
        intervalMs: 5_000,
        sendTimeoutMs: SEND_TIMEOUT_MS,
      }),
      inject: [APP_CONFIG],
    },
    NotificationWorker,
  ],
  exports: [AlertDefaults, AlertRulesService],
})
export class AlertsModule {}
