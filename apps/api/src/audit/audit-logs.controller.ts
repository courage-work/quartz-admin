import { Controller, Get, Inject, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import {
  type AuditExportQuery,
  type AuditLogDto,
  type AuditLogPage,
  type AuditLogQuery,
  auditExportQuerySchema,
  auditLogQuerySchema,
} from '@qa/shared';
import type { Response } from 'express';
import { once } from 'node:events';
import { notFound } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuditService } from './audit.service.js';
import { AUDIT_CSV_PREAMBLE, auditCsvFilename, auditCsvRow } from './csv.js';

/**
 * 감사 로그 조회 (PRD FR-AUD-03). 로그인한 사용자는 모두 볼 수 있다(PRD 권한 모델).
 * 수정·삭제 경로는 두지 않는다 (FR-AUD-04).
 */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  list(@Query(new ZodPipe(auditLogQuerySchema)) query: AuditLogQuery): AuditLogPage {
    return this.audit.list(query);
  }

  /**
   * CSV 내보내기 (FR-AUD-05). 목록과 같은 필터로 맞는 기록을 최신순으로 모두 내보낸다. 1,000건씩 읽어 바로 쓰고,
   * 응답 버퍼가 차면 비워질 때까지 기다려 몇 건이든 메모리 사용량이 일정하다. 받는 쪽이 끊으면 멈춘다.
   * `:id`보다 먼저 둬야 `export.csv`가 id로 해석되지 않는다
   */
  @Get('export.csv')
  async exportCsv(
    @Query(new ZodPipe(auditExportQuerySchema)) query: AuditExportQuery,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${auditCsvFilename(this.clock())}"`,
    );
    const closed = once(res, 'close');
    res.write(AUDIT_CSV_PREAMBLE);
    for (const batch of this.audit.exportBatches(query)) {
      if (res.destroyed) return;
      if (!res.write(batch.map(auditCsvRow).join(''))) {
        await Promise.race([once(res, 'drain'), closed]);
      }
    }
    if (!res.destroyed) res.end();
  }

  /** 상세 화면(`/audit-log?id=N`)용 */
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): AuditLogDto {
    const log = this.audit.get(id);
    if (!log) throw notFound('감사 기록을 찾을 수 없습니다');
    return log;
  }
}
