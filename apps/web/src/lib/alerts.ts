import {
  type AlertDto,
  type AlertRuleDto,
  type AlertRuleInput,
  type AlertRuleType,
  type AlertScope,
  BLOCKED_MINUTES_DEFAULT,
  UNREACHABLE_FAILURES_DEFAULT,
} from '@qa/shared';

import { formatInterval } from '@/lib/schedulers';

export const alertRulesKey = (schedulerId: number) =>
  ['schedulers', schedulerId, 'alert-rules'] as const;
export const schedulerAlertsKey = (schedulerId: number) =>
  ['schedulers', schedulerId, 'alerts'] as const;

/** 규칙 타입 이름과 대상 요약은 Slack·이메일 메시지와 같아야 해서 `@qa/shared`에 둔다 */
export { ALERT_RULE_LABELS, describeAffected } from '@qa/shared';

/** 규칙 추가 화면에서 고르는 순서 */
export const ALERT_RULE_ORDER: readonly AlertRuleType[] = [
  'OVERDUE',
  'TRIGGER_ERROR',
  'BLOCKED_LONG',
  'NODE_MISSING',
  'CLUSTER_DOWN',
  'MONITOR_UNREACHABLE',
];

export interface SchedulerThresholds {
  misfireThresholdMs: number;
  overdueGraceMs: number;
  expectedNodeCount: number;
  checkinMultiplier: number;
}

/** 규칙의 조건을 한 줄로 */
export function describeCondition(
  rule: Pick<AlertRuleDto, 'type' | 'params'>,
  s: SchedulerThresholds,
): string {
  switch (rule.type) {
    case 'OVERDUE':
      return `대기 트리거가 다음 실행 시각보다 ${formatInterval(s.misfireThresholdMs + s.overdueGraceMs)} 넘게 밀림`;
    case 'TRIGGER_ERROR':
      return 'ERROR 상태 트리거가 있음';
    case 'BLOCKED_LONG':
      return `BLOCKED가 ${rule.params.minutes ?? BLOCKED_MINUTES_DEFAULT}분 넘게 이어짐`;
    case 'NODE_MISSING':
      return `활성 노드가 기대 노드 수(${s.expectedNodeCount}개)보다 적음`;
    case 'CLUSTER_DOWN':
      return '활성 노드가 0개';
    case 'MONITOR_UNREACHABLE':
      return `감시가 ${rule.params.failures ?? UNREACHABLE_FAILURES_DEFAULT}회 연속 실패`;
  }
}

export function describeScope(scope: AlertScope): string {
  switch (scope.kind) {
    case 'all':
      return '전체';
    case 'groups':
      return scope.groups.length === 1
        ? `그룹 ${scope.groups[0]}`
        : `그룹 ${scope.groups[0]} 외 ${scope.groups.length - 1}개`;
    case 'triggers': {
      const [first] = scope.triggers;
      const name = first ? `${first.group}.${first.name}` : '';
      return scope.triggers.length === 1
        ? `트리거 ${name}`
        : `트리거 ${name} 외 ${scope.triggers.length - 1}개`;
    }
  }
}

export function describeRenotify(minutes: number | null): string {
  if (minutes === null) return '안 함';
  if (minutes % 60 === 0) return `${minutes / 60}시간마다`;
  return `${minutes}분마다`;
}

/** 알림 상태 칸의 글. 억제·발송 전이면 그 사정을 덧붙인다 */
export function describeAlertStatus(
  alert: Pick<AlertDto, 'status' | 'suppressed' | 'notified'>,
): string {
  if (alert.status === 'resolved') return '해소';
  const base = alert.status === 'acked' ? '확인함' : '열림';
  if (alert.suppressed) return `${base} · 억제 중`;
  if (!alert.notified) return `${base} · 발송 전`;
  return base;
}

/** 저장된 규칙을 같은 값의 요청 본문으로 (켜기·끄기 토글) */
export function ruleInputOf(
  rule: AlertRuleDto,
  patch: Partial<AlertRuleInput> = {},
): AlertRuleInput {
  return {
    type: rule.type,
    params: rule.params,
    scope: rule.scope,
    severity: rule.severity,
    renotifyMinutes: rule.renotifyMinutes,
    enabled: rule.enabled,
    ...patch,
  } as AlertRuleInput;
}

// ── 규칙 폼 (`/scheduler/alert-rule`) ───────────────────────────

export type ScopeKind = AlertScope['kind'];

/** 화면 입력 형태. 요청 본문({@link toRuleRequest})으로 바꾼 뒤 서버와 같은 스키마로 검사한다 */
export interface RuleFormValues {
  type: AlertRuleType;
  /** BLOCKED_LONG */
  minutes: string;
  /** MONITOR_UNREACHABLE */
  failures: string;
  scopeKind: ScopeKind;
  /** 줄마다 그룹 하나 */
  groups: string;
  triggers: { group: string; name: string }[];
  severity: AlertRuleInput['severity'];
  /** 비우면 재알림하지 않는다 */
  renotify: string;
  enabled: boolean;
  /** 보낼 채널 */
  channelIds: number[];
}

const DEFAULT_SEVERITY: Record<AlertRuleType, AlertRuleInput['severity']> = {
  OVERDUE: 'warning',
  TRIGGER_ERROR: 'critical',
  BLOCKED_LONG: 'warning',
  NODE_MISSING: 'warning',
  CLUSTER_DOWN: 'critical',
  MONITOR_UNREACHABLE: 'critical',
};

export function defaultSeverity(type: AlertRuleType): AlertRuleInput['severity'] {
  return DEFAULT_SEVERITY[type];
}

/** 새 규칙은 `defaultChannelIds`(인앱 채널)를 골라 둔다 */
export function ruleFormValues(
  rule?: AlertRuleDto,
  defaultChannelIds: number[] = [],
): RuleFormValues {
  if (!rule) {
    return {
      type: 'OVERDUE',
      minutes: String(BLOCKED_MINUTES_DEFAULT),
      failures: String(UNREACHABLE_FAILURES_DEFAULT),
      scopeKind: 'all',
      groups: '',
      triggers: [{ group: '', name: '' }],
      severity: DEFAULT_SEVERITY.OVERDUE,
      renotify: '',
      enabled: true,
      channelIds: [...defaultChannelIds],
    };
  }
  return {
    type: rule.type,
    minutes: String(rule.params.minutes ?? BLOCKED_MINUTES_DEFAULT),
    failures: String(rule.params.failures ?? UNREACHABLE_FAILURES_DEFAULT),
    scopeKind: rule.scope.kind,
    groups: rule.scope.kind === 'groups' ? rule.scope.groups.join('\n') : '',
    triggers:
      rule.scope.kind === 'triggers'
        ? rule.scope.triggers.map((t) => ({ ...t }))
        : [{ group: '', name: '' }],
    severity: rule.severity,
    renotify: rule.renotifyMinutes === null ? '' : String(rule.renotifyMinutes),
    enabled: rule.enabled,
    channelIds: [...rule.channelIds],
  };
}

function scopeOf(v: RuleFormValues): unknown {
  switch (v.scopeKind) {
    case 'all':
      return { kind: 'all' };
    case 'groups':
      return {
        kind: 'groups',
        groups: v.groups
          .split(/\r?\n/)
          .map((g) => g.trim())
          .filter(Boolean),
      };
    case 'triggers':
      return {
        kind: 'triggers',
        // 빈 줄도 그대로 보낸다. 줄 번호가 화면과 같아야 오류를 그 줄에 붙일 수 있다
        triggers: v.triggers.map((t) => ({ group: t.group, name: t.name })),
      };
  }
}

/** 화면 값 → 요청 본문. 타입마다 쓰지 않는 칸은 보내지 않는다 */
export function toRuleRequest(v: RuleFormValues): unknown {
  const params =
    v.type === 'BLOCKED_LONG'
      ? { minutes: v.minutes.trim() }
      : v.type === 'MONITOR_UNREACHABLE'
        ? { failures: v.failures.trim() }
        : {};
  return {
    type: v.type,
    params,
    scope: isTriggerRule(v.type) ? scopeOf(v) : { kind: 'all' },
    severity: v.severity,
    renotifyMinutes: v.renotify.trim() === '' ? null : v.renotify.trim(),
    enabled: v.enabled,
    channelIds: v.channelIds,
  };
}

export function isTriggerRule(type: AlertRuleType): boolean {
  return type === 'OVERDUE' || type === 'TRIGGER_ERROR' || type === 'BLOCKED_LONG';
}

/**
 * 요청 본문의 오류 경로를 폼 입력 경로로. 트리거 줄의 오류는 그 줄의 칸(`triggers.0.group`)으로,
 * 줄 수 오류는 목록(`triggers`)으로 보낸다
 */
export function ruleFormPathOf(path: readonly PropertyKey[]): string | null {
  const [head, second, ...rest] = path.map(String);
  if (head === 'params') return second === 'minutes' || second === 'failures' ? second : null;
  if (head === 'scope') {
    if (second === 'groups') return 'groups';
    if (second === 'triggers')
      return rest.length >= 2 ? `triggers.${rest[0]}.${rest[1]}` : 'triggers';
    return 'scopeKind';
  }
  if (head === 'renotifyMinutes') return 'renotify';
  if (head === 'severity' || head === 'type' || head === 'enabled' || head === 'channelIds') {
    return head;
  }
  return null;
}
