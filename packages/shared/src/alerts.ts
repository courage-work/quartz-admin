/**
 * 알림 규칙과 알림 (TRD §9.2, §9.3, PRD FR-ALT-01~06, 08, 09)
 *
 * 규칙은 스케줄러마다 둔다. 트리거 단위 규칙(`OVERDUE`, `TRIGGER_ERROR`, `BLOCKED_LONG`)은 적용 범위로 대상을 좁힐 수 있고,
 * 스케줄러 단위 규칙(`NODE_MISSING`, `CLUSTER_DOWN`, `MONITOR_UNREACHABLE`)은 늘 스케줄러 전체가 대상이다.
 */
import { z } from 'zod';
import { SEVERITIES, type AlertRuleType, type AlertStatus, type Severity } from './domain.js';
import type { TriggerRef } from './monitor.js';

const NAME_MAX = 200;
/** 적용 범위에 적는 그룹·트리거 수 상한 */
export const ALERT_SCOPE_MAX = 100;
/** 알림의 대상 목록(affected)에 남기는 트리거 수 상한. 감시가 읽는 목록 상한(500)과 같다 */
export const ALERT_AFFECTED_MAX = 500;

/** 적용 범위를 쓸 수 있는 트리거 단위 규칙 */
export const TRIGGER_RULE_TYPES = ['OVERDUE', 'TRIGGER_ERROR', 'BLOCKED_LONG'] as const;
export function isTriggerRuleType(type: AlertRuleType): boolean {
  return (TRIGGER_RULE_TYPES as readonly string[]).includes(type);
}

/** 열려 있으면 같은 스케줄러의 다른 알림 발송을 막는 규칙 (FR-ALT-09) */
export const SUPPRESSING_RULE_TYPES = ['CLUSTER_DOWN', 'MONITOR_UNREACHABLE'] as const;
/** 위 규칙이 열려 있으면 평가는 하되 발송하지 않는 규칙 */
export const SUPPRESSED_RULE_TYPES = ['OVERDUE', 'BLOCKED_LONG', 'NODE_MISSING'] as const;

export const BLOCKED_MINUTES_DEFAULT = 30;
export const BLOCKED_MINUTES_MAX = 7 * 24 * 60;
export const UNREACHABLE_FAILURES_DEFAULT = 3;
export const UNREACHABLE_FAILURES_MAX = 100;
export const RENOTIFY_MINUTES_MAX = 7 * 24 * 60;

const groupName = z
  .string({ error: '그룹 이름이 필요합니다' })
  .trim()
  .min(1, { error: '그룹 이름을 입력하세요' })
  .max(NAME_MAX);
const scopeTrigger = z.object({ group: groupName, name: groupName });

export const alertScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('groups'),
    groups: z
      .array(groupName)
      .min(1, { error: '그룹을 하나 이상 입력하세요' })
      .max(ALERT_SCOPE_MAX, { error: `그룹은 ${ALERT_SCOPE_MAX}개까지 입력할 수 있습니다` }),
  }),
  z.object({
    kind: z.literal('triggers'),
    triggers: z
      .array(scopeTrigger)
      .min(1, { error: '트리거를 하나 이상 입력하세요' })
      .max(ALERT_SCOPE_MAX, { error: `트리거는 ${ALERT_SCOPE_MAX}개까지 입력할 수 있습니다` }),
  }),
]);
export type AlertScope = z.infer<typeof alertScopeSchema>;

const intIn = (label: string, min: number, max: number) =>
  z.coerce
    .number({ error: `${label}을(를) 입력하세요` })
    .int({ error: `${label}은(는) 정수여야 합니다` })
    .min(min, { error: `${label}은(는) ${min} 이상이어야 합니다` })
    .max(max, { error: `${label}은(는) ${max} 이하여야 합니다` });

const common = {
  severity: z.enum(SEVERITIES),
  /** null이면 재알림하지 않는다 */
  renotifyMinutes: intIn('재알림 간격', 1, RENOTIFY_MINUTES_MAX).nullable(),
  enabled: z.boolean(),
};
const allScope = z.object({ kind: z.literal('all') }).default({ kind: 'all' });
const noParams = z.object({}).default({});

/** `POST /schedulers/:id/alert-rules`, `PUT /alert-rules/:id` (FR-ALT-06) */
export const alertRuleInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('OVERDUE'), params: noParams, scope: alertScopeSchema, ...common }),
  z.object({
    type: z.literal('TRIGGER_ERROR'),
    params: noParams,
    scope: alertScopeSchema,
    ...common,
  }),
  z.object({
    type: z.literal('BLOCKED_LONG'),
    params: z.object({ minutes: intIn('BLOCKED 지속 시간', 1, BLOCKED_MINUTES_MAX) }),
    scope: alertScopeSchema,
    ...common,
  }),
  z.object({ type: z.literal('NODE_MISSING'), params: noParams, scope: allScope, ...common }),
  z.object({ type: z.literal('CLUSTER_DOWN'), params: noParams, scope: allScope, ...common }),
  z.object({
    type: z.literal('MONITOR_UNREACHABLE'),
    params: z.object({ failures: intIn('연속 실패 횟수', 1, UNREACHABLE_FAILURES_MAX) }),
    scope: allScope,
    ...common,
  }),
]);
export type AlertRuleInput = z.infer<typeof alertRuleInputSchema>;

/** 규칙 타입별 매개변수 */
export interface AlertRuleParams {
  /** BLOCKED_LONG: BLOCKED가 이어진 시간(분) */
  minutes?: number;
  /** MONITOR_UNREACHABLE: 연속 감시 실패 횟수 */
  failures?: number;
}

export interface AlertRuleDto {
  id: number;
  schedulerId: number;
  type: AlertRuleType;
  params: AlertRuleParams;
  scope: AlertScope;
  severity: Severity;
  renotifyMinutes: number | null;
  enabled: boolean;
  /** 연결된 채널. 채널 관리는 B-25 */
  channelIds: number[];
  createdAt: number;
  updatedAt: number;
}

/** 스케줄러를 등록하면 만드는 기본 규칙 세트 (TRD §9.2) */
export const DEFAULT_ALERT_RULES: readonly Omit<AlertRuleInput, 'scope'>[] = [
  { type: 'OVERDUE', params: {}, severity: 'warning', renotifyMinutes: null, enabled: true },
  { type: 'TRIGGER_ERROR', params: {}, severity: 'critical', renotifyMinutes: 60, enabled: true },
  {
    type: 'BLOCKED_LONG',
    params: { minutes: BLOCKED_MINUTES_DEFAULT },
    severity: 'warning',
    renotifyMinutes: null,
    enabled: true,
  },
  { type: 'NODE_MISSING', params: {}, severity: 'warning', renotifyMinutes: null, enabled: true },
  { type: 'CLUSTER_DOWN', params: {}, severity: 'critical', renotifyMinutes: 60, enabled: true },
  {
    type: 'MONITOR_UNREACHABLE',
    params: { failures: UNREACHABLE_FAILURES_DEFAULT },
    severity: 'critical',
    renotifyMinutes: 60,
    enabled: true,
  },
];

// ── 알림 ─────────────────────────────────────────────────────────

/** 알림 대상 트리거. 연체면 다음 실행 시각, BLOCKED면 처음 본 시각(대상 DB 시각)을 붙인다 */
export interface AlertTriggerItem extends TriggerRef {
  nextFireTime?: number;
  state?: string;
  since?: number;
}

export interface AlertNodeItem {
  instanceName: string;
  active: boolean;
  lastCheckinTime: number | null;
}

/** 알림이 가리키는 대상 (`alerts.affected_json`) */
export type AlertAffected =
  | {
      kind: 'triggers';
      /** 조건에 맞는 트리거 수. 목록은 {@link ALERT_AFFECTED_MAX}개까지 */
      total: number;
      triggers: AlertTriggerItem[];
    }
  | { kind: 'nodes'; active: number; expected: number; nodes: AlertNodeItem[] }
  | { kind: 'monitor'; failures: number; errorCode: string | null; errorMessage: string | null };

export interface AlertDto {
  id: number;
  schedulerId: number;
  /** 규칙을 지웠으면 null */
  ruleId: number | null;
  type: AlertRuleType;
  severity: Severity;
  status: AlertStatus;
  affected: AlertAffected | null;
  /** 도구 서버 시각 */
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  ackedAt: number | null;
  /** 한 번이라도 발송했는지. 억제 중에 열린 알림은 false */
  notified: boolean;
  /** 지금 억제되어 발송하지 않는 중인지 (FR-ALT-09) */
  suppressed: boolean;
}

/** `GET /schedulers/:id/alerts` */
export interface SchedulerAlertsResponse {
  /** 해소 전(open, acked) 알림. 심각도 높은 순, 최근 순 */
  open: AlertDto[];
  /** 최근 해소된 알림 */
  resolved: AlertDto[];
}

/** `GET /schedulers/:id/alert-rules` */
export interface AlertRulesResponse {
  rules: AlertRuleDto[];
}

export const ALERT_RESOLVED_LISTED = 20;
