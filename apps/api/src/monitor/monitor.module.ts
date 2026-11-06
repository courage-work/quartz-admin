import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { MonitorHooks } from './monitor-hooks.js';
import { MONITOR_OPTIONS, MonitorService, type MonitorOptions } from './monitor.service.js';
import { SchedulerEvents } from './scheduler-events.js';

/**
 * 감시 루프 (TRD §9.1). 접속 관리가 보내는 `SchedulerEvents`와 알림 엔진(B-24)이 붙는 `MonitorHooks`를
 * 다른 모듈이 쓰도록 전역으로 둔다.
 */
@Global()
@Module({
  providers: [
    SchedulerEvents,
    MonitorHooks,
    {
      provide: MONITOR_OPTIONS,
      useFactory: (config: AppConfig): MonitorOptions => ({
        enabled: true,
        concurrency: config.monitorConcurrency,
        roundTimeoutMs: 30_000,
      }),
      inject: [APP_CONFIG],
    },
    MonitorService,
  ],
  exports: [SchedulerEvents, MonitorHooks, MonitorService],
})
export class MonitorModule {}
