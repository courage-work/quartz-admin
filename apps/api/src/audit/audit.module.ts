import { Global, Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller.js';
import { AuditService } from './audit.service.js';

/** 감사 로그 (TRD §10). 상태를 바꾸는 모든 기능 모듈이 쓰므로 전역으로 둔다 */
@Global()
@Module({
  controllers: [AuditLogsController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
