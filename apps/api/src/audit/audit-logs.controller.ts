import { Controller, Get, Query } from '@nestjs/common';
import { type AuditLogPage, type AuditLogQuery, auditLogQuerySchema } from '@qa/shared';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuditService } from './audit.service.js';

/**
 * 감사 로그 조회 (PRD FR-AUD-03). 로그인한 사용자는 모두 볼 수 있다(PRD 권한 모델).
 * 수정·삭제 경로는 두지 않는다 (FR-AUD-04).
 */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query(new ZodPipe(auditLogQuerySchema)) query: AuditLogQuery): AuditLogPage {
    return this.audit.list(query);
  }
}
