/**
 * 감사 로그 조회 API의 요청 스키마와 응답 타입 (TRD §10, PRD FR-AUD)
 */
import { z } from 'zod';
import { AUDIT_RESULTS, type AuditResult } from './domain.js';

/**
 * 작업 종류. 기능을 추가하는 작업이 여기에 이어 붙인다.
 * 화면의 작업 종류 필터도 이 목록을 쓴다.
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.password_change',
  'user.create',
  'user.activate',
  'user.deactivate',
  'user.password_reset',
  'connection.create',
  'connection.update',
  'connection.delete',
  'connection.detect',
  'scheduler.register',
  'scheduler.update',
  'scheduler.delete',
  'scheduler.mute',
  'scheduler.unmute',
  'trigger.pause',
  'trigger.resume',
  'job.pause',
  'job.resume',
  'trigger_group.pause',
  'trigger_group.resume',
  'job_group.pause',
  'job_group.resume',
  'scheduler.pause',
  'scheduler.resume',
  'job.trigger',
  'trigger.reschedule',
  'trigger.delete',
  'job.delete',
  'alert_rule.create',
  'alert_rule.update',
  'alert_rule.delete',
  'channel.create',
  'channel.update',
  'channel.delete',
  'channel.test',
  'alert.ack',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 대상 종류 */
export const AUDIT_TARGET_TYPES = [
  'user',
  'connection',
  'scheduler',
  'trigger',
  'job',
  'trigger_group',
  'job_group',
  'alert_rule',
  'channel',
  'alert',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * 기동 시 `pending`으로 남아 있던 기록에 붙이는 오류 코드.
 * 작업 도중 프로세스가 끝나 결과를 알 수 없다는 뜻이다 (TRD §10)
 */
export const AUDIT_INTERRUPTED = 'INTERRUPTED';

export const AUDIT_PAGE_SIZE_DEFAULT = 50;
export const AUDIT_PAGE_SIZE_MAX = 200;

const optionalInt = z.coerce.number().int().positive().optional();
const optionalTime = z.coerce.number().int().nonnegative().optional();

/** 감사 로그 필터. 시각은 epoch ms이고 `from`은 포함, `to`는 제외한다 (FR-AUD-03) */
const auditFilterFields = {
  from: optionalTime,
  to: optionalTime,
  userId: optionalInt,
  username: z.string().trim().toLowerCase().min(1).max(64).optional(),
  schedulerId: optionalInt,
  action: z.enum(AUDIT_ACTIONS).optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
};

const validRange = (q: { from?: number; to?: number }) =>
  q.from === undefined || q.to === undefined || q.from < q.to;
const rangeError = { error: '시작 시각은 끝 시각보다 앞서야 합니다', path: ['to'] };

/** `GET /audit-logs` 쿼리 */
export const auditLogQuerySchema = z
  .object({
    ...auditFilterFields,
    /** 이전 응답의 `nextCursor`. 이 id보다 오래된 기록부터 돌려준다 */
    cursor: optionalInt,
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).default(AUDIT_PAGE_SIZE_DEFAULT),
  })
  .refine(validRange, rangeError);
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

/** `GET /audit-logs/export.csv` 쿼리 (FR-AUD-05). 목록과 같은 필터로 맞는 기록을 모두 내보낸다 */
export const auditExportQuerySchema = z.object(auditFilterFields).refine(validRange, rangeError);
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

/** 감사 로그 필터(목록·내보내기 공통) */
export type AuditFilter = AuditExportQuery;

export interface AuditLogDto {
  id: number;
  at: number;
  userId: number | null;
  /** 기록 당시 아이디. 없는 아이디로 로그인을 시도한 경우에도 남는다 */
  username: string | null;
  ip: string | null;
  requestId: string | null;
  action: string;
  targetType: string | null;
  /** 비밀값은 마스킹된 상태로 저장된다 */
  target: unknown;
  connectionId: number | null;
  schedulerId: number | null;
  before: unknown;
  after: unknown;
  result: AuditResult;
  errorCode: string | null;
  errorMessage: string | null;
  reason: string | null;
}

/** 최신 기록이 먼저 온다. `nextCursor`가 null이면 마지막 페이지다 */
export interface AuditLogPage {
  items: AuditLogDto[];
  nextCursor: number | null;
}
