import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AUDIT_INTERRUPTED,
  type AuditAction,
  type AuditLogDto,
  type AuditLogPage,
  type AuditLogQuery,
  type AuditTargetType,
} from '@qa/shared';
import { and, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import { ApiError } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { MaintenanceService } from '../meta-db/maintenance.service.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { auditLogs } from '../meta-db/schema.js';
import { maskSecrets } from './mask.js';

const DAY_MS = 86_400_000;
const MAX_MESSAGE_LENGTH = 1_000;

/** 작업한 사람과 요청 정보. 시스템이 한 작업은 `SYSTEM_ACTOR` */
export interface AuditActor {
  userId: number | null;
  username: string | null;
  ip: string | null;
  requestId: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, username: null, ip: null, requestId: null };

export interface AuditEntry {
  actor: AuditActor;
  action: AuditAction;
  targetType?: AuditTargetType;
  target?: unknown;
  connectionId?: number;
  schedulerId?: number;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** 작업이 끝난 뒤 채우는 값 */
export interface AuditOutcome {
  target?: unknown;
  before?: unknown;
  after?: unknown;
}

/** 오류를 감사 기록용 코드와 메시지로 바꾼다. 처리하지 못한 예외의 내부 메시지는 남기지 않는다 */
export function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof ApiError) return { code: err.code, message: err.body.message };
  return { code: 'INTERNAL_ERROR', message: '처리하지 못한 서버 오류' };
}

type AuditRow = typeof auditLogs.$inferSelect;

function toDto(row: AuditRow): AuditLogDto {
  return {
    id: row.id,
    at: row.at,
    userId: row.userId,
    username: row.username,
    ip: row.ip,
    requestId: row.requestId,
    action: row.action,
    targetType: row.targetType,
    target: row.target ?? null,
    connectionId: row.connectionId,
    schedulerId: row.schedulerId,
    before: row.before ?? null,
    after: row.after ?? null,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    reason: row.reason,
  };
}

/** 저장 직전에 마스킹한다. undefined는 null로 저장된다 */
function json(value: unknown): unknown {
  return value === undefined ? null : maskSecrets(value);
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
}

/**
 * 감사 로그 (TRD §10, PRD FR-AUD-01~04)
 *
 * - 앱 코드에서 할 수 있는 일은 기록 추가와 `pending` 결과 갱신뿐이다. 수정·삭제 경로는 보존 정리(`prune`)만 있다.
 * - 오래 걸리거나 대상 DB를 바꾸는 작업은 `begin`으로 먼저 `pending`을 남기고 끝나면 결과를 채운다(TRD §7.1).
 *   기록을 남기지 못하면 작업도 하지 않는다.
 * - 바로 끝나는 이벤트(로그인 등)는 `success`/`failure`로 한 번에 기록한다.
 */
@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly metaDb: MetaDbService,
    private readonly maintenance: MaintenanceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    const n = this.recoverInterrupted();
    if (n > 0)
      this.logger.warn(`결과가 남지 않은 감사 기록 ${n}건을 중단(INTERRUPTED)으로 정리했습니다`);
    this.maintenance.register({ name: 'audit_logs', run: (now) => this.prune(now) });
  }

  success(entry: AuditEntry): number {
    return this.insert(entry, { result: 'success' });
  }

  /** 실패 기록은 원래 오류를 가리지 않도록, 기록 자체가 실패해도 예외를 던지지 않는다 */
  failure(entry: AuditEntry, err: unknown): number | null {
    const { code, message } = describeError(err);
    try {
      return this.insert(entry, {
        result: 'failure',
        errorCode: code,
        errorMessage: truncate(message),
      });
    } catch (writeErr) {
      this.logger.error(`감사 기록 실패 (${entry.action}): ${String(writeErr)}`);
      return null;
    }
  }

  /** `pending`을 남기고 결과를 채울 핸들을 돌려준다 */
  begin(entry: AuditEntry): PendingAudit {
    const id = this.insert(entry, { result: 'pending' });
    return new PendingAudit(this, id, entry.action);
  }

  /**
   * `fn`을 `pending` → `success`/`failure` 기록으로 감싼다. `fn`의 오류는 그대로 다시 던진다.
   * @param outcome 성공 결과에서 `after` 등을 만든다
   */
  async run<T>(
    entry: AuditEntry,
    fn: () => T | Promise<T>,
    outcome?: (result: T) => AuditOutcome,
  ): Promise<T> {
    const pending = this.begin(entry);
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      pending.fail(err);
      throw err;
    }
    pending.succeed(outcome?.(result));
    return result;
  }

  /** @internal PendingAudit만 호출한다. 이미 결과가 정해진 기록은 바꾸지 않는다 */
  complete(
    id: number,
    patch: { result: 'success' | 'failure'; errorCode?: string; errorMessage?: string },
    outcome: AuditOutcome = {},
  ): boolean {
    const set: Partial<typeof auditLogs.$inferInsert> = { ...patch };
    if (outcome.target !== undefined) set.target = json(outcome.target);
    if (outcome.before !== undefined) set.before = json(outcome.before);
    if (outcome.after !== undefined) set.after = json(outcome.after);
    const res = this.metaDb.db
      .update(auditLogs)
      .set(set)
      .where(and(eq(auditLogs.id, id), eq(auditLogs.result, 'pending')))
      .run();
    return res.changes > 0;
  }

  /** 기동 시 `pending`으로 남은 기록을 `failure(INTERRUPTED)`로 정리한다. 단일 인스턴스 락 덕분에 진행 중인 작업은 없다 */
  recoverInterrupted(): number {
    return this.metaDb.db
      .update(auditLogs)
      .set({
        result: 'failure',
        errorCode: AUDIT_INTERRUPTED,
        errorMessage: '작업 도중 서버가 종료돼 결과를 확인하지 못했습니다',
      })
      .where(eq(auditLogs.result, 'pending'))
      .run().changes;
  }

  list(query: AuditLogQuery): AuditLogPage {
    const conds: SQL[] = [];
    if (query.from !== undefined) conds.push(gte(auditLogs.at, query.from));
    if (query.to !== undefined) conds.push(lt(auditLogs.at, query.to));
    if (query.userId !== undefined) conds.push(eq(auditLogs.userId, query.userId));
    if (query.username !== undefined) conds.push(eq(auditLogs.username, query.username));
    if (query.schedulerId !== undefined) conds.push(eq(auditLogs.schedulerId, query.schedulerId));
    if (query.action !== undefined) conds.push(eq(auditLogs.action, query.action));
    if (query.result !== undefined) conds.push(eq(auditLogs.result, query.result));
    if (query.cursor !== undefined) conds.push(lt(auditLogs.id, query.cursor));

    // 한 건 더 읽어 다음 페이지가 있는지 판단한다
    const rows = this.metaDb.db
      .select()
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.id))
      .limit(query.limit + 1)
      .all();
    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map(toDto);
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  get(id: number): AuditLogDto | null {
    const row = this.metaDb.db.select().from(auditLogs).where(eq(auditLogs.id, id)).get();
    return row ? toDto(row) : null;
  }

  /** 보존 기간(`QA_AUDIT_RETENTION_DAYS`)이 지난 기록을 지운다 (FR-AUD-04) */
  prune(now: number): number {
    const cutoff = now - this.config.auditRetentionDays * DAY_MS;
    return this.metaDb.db.delete(auditLogs).where(lt(auditLogs.at, cutoff)).run().changes;
  }

  private insert(
    entry: AuditEntry,
    result: Pick<typeof auditLogs.$inferInsert, 'result' | 'errorCode' | 'errorMessage'>,
  ): number {
    const row = this.metaDb.db
      .insert(auditLogs)
      .values({
        at: this.clock(),
        userId: entry.actor.userId,
        username: entry.actor.username,
        ip: entry.actor.ip,
        requestId: entry.actor.requestId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        target: json(entry.target),
        connectionId: entry.connectionId ?? null,
        schedulerId: entry.schedulerId ?? null,
        before: json(entry.before),
        after: json(entry.after),
        reason: entry.reason ?? null,
        ...result,
      })
      .returning({ id: auditLogs.id })
      .get();
    return row.id;
  }
}

/** `begin`이 남긴 `pending` 기록의 결과를 채운다 */
export class PendingAudit {
  constructor(
    private readonly audit: AuditService,
    readonly id: number,
    private readonly action: string,
  ) {}

  succeed(outcome?: AuditOutcome): void {
    this.audit.complete(this.id, { result: 'success' }, outcome);
  }

  /** 원래 오류를 가리지 않도록, 결과 갱신이 실패해도 예외를 던지지 않는다. 남은 `pending`은 다음 기동 때 정리된다 */
  fail(err: unknown, outcome?: AuditOutcome): void {
    const { code, message } = describeError(err);
    try {
      this.audit.complete(
        this.id,
        { result: 'failure', errorCode: code, errorMessage: truncate(message) },
        outcome,
      );
    } catch (writeErr) {
      new Logger(AuditService.name).error(
        `감사 결과 기록 실패 (${this.action} #${this.id}): ${String(writeErr)}`,
      );
    }
  }
}
