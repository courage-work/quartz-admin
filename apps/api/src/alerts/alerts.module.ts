import { Module } from '@nestjs/common';
import { AlertDefaults } from './alert-defaults.js';
import { AlertEngine } from './alert-engine.js';
import { AlertRulesService } from './alert-rules.service.js';

/**
 * 알림 규칙 엔진 (TRD §9.2, §9.3, B-24). 감시 루프의 확장 지점(`MonitorHooks`)에 엔진을 붙이고,
 * 접속 관리가 스케줄러를 등록할 때 쓰는 기본 규칙(`AlertDefaults`)을 내보낸다.
 * 컨트롤러는 `ConnectionsService`가 필요해 접속 모듈에 둔다.
 */
@Module({
  providers: [AlertDefaults, AlertEngine, AlertRulesService],
  exports: [AlertDefaults, AlertRulesService],
})
export class AlertsModule {}
