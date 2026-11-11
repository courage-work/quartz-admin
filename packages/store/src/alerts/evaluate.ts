import {
  ALERT_AFFECTED_MAX,
  BLOCKED_MINUTES_DEFAULT,
  UNREACHABLE_FAILURES_DEFAULT,
  type AlertAffected,
  type AlertRuleParams,
  type AlertRuleType,
  type AlertScope,
  type AlertTriggerItem,
  type MonitorData,
  type NotificationEvent,
  type TriggerRef,
} from '@qa/shared';

/**
 * 알림 규칙 판정과 수명주기 (TRD §9.2, §9.3). 대상 DB도 메타 저장소도 건드리지 않는 순수 함수로 두어
 * 감시 루프(apps/api)와 통합 테스트가 같은 판정을 쓴다.
 */

/** 트리거를 집합·맵의 키로 쓴다 */
export function triggerKeyOf(t: TriggerRef): string {
  return `${t.group}\u0000${t.name}`;
}

export function inScope(scope: AlertScope, t: TriggerRef): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'groups':
      return scope.groups.includes(t.group);
    case 'triggers':
      return scope.triggers.some((s) => s.group === t.group && s.name === t.name);
  }
}

// ── BLOCKED 관찰 ─────────────────────────────────────────────────

export interface TriggerObservation extends TriggerRef {
  state: string;
  /** 처음 BLOCKED(또는 PAUSED_BLOCKED)로 본 대상 DB 시각 */
  firstSeenAt: number;
}

export interface ObservationUpdate {
  /** 이번 회차 뒤의 관찰 전체 */
  next: TriggerObservation[];
  /** 새로 보거나 상태가 바뀐 행 */
  upserts: TriggerObservation[];
  /** 더는 BLOCKED가 아니어서 지울 행 */
  removed: TriggerRef[];
}

/**
 * `trigger_observations` 갱신 (TRD §9.2 BLOCKED_LONG). BLOCKED와 PAUSED_BLOCKED는 같은 "막힘"으로 보고
 * 둘 사이를 오가도 처음 본 시각을 유지한다. 목록에서 빠진 트리거는 막힘이 풀린 것으로 보고 지운다.
 */
export function observeBlocked(
  previous: readonly TriggerObservation[],
  blocked: readonly (TriggerRef & { state: string })[],
  dbNow: number,
): ObservationUpdate {
  const prev = new Map(previous.map((o) => [triggerKeyOf(o), o]));
  const next: TriggerObservation[] = [];
  const upserts: TriggerObservation[] = [];
  const seen = new Set<string>();
  for (const t of blocked) {
    const key = triggerKeyOf(t);
    seen.add(key);
    const old = prev.get(key);
    const obs = {
      group: t.group,
      name: t.name,
      state: t.state,
      firstSeenAt: old?.firstSeenAt ?? dbNow,
    };
    next.push(obs);
    if (!old || old.state !== t.state) upserts.push(obs);
  }
  const removed = previous
    .filter((o) => !seen.has(triggerKeyOf(o)))
    .map(({ group, name }) => ({ group, name }));
  return { next, upserts, removed };
}

// ── 판정 ─────────────────────────────────────────────────────────

export interface AlertRuleSpec {
  type: AlertRuleType;
  params: AlertRuleParams;
  scope: AlertScope;
}

export type MonitorResult =
  | { ok: true; data: MonitorData }
  | {
      ok: false;
      consecutiveFailures: number;
      errorCode: string | null;
      errorMessage: string | null;
    };

export interface EvaluationInput {
  result: MonitorResult;
  expectedNodeCount: number;
  /** 트리거 키 → BLOCKED로 처음 본 대상 DB 시각 ({@link observeBlocked}의 결과) */
  blockedSince: ReadonlyMap<string, number>;
  /** 최근 도구가 재개해 연체 판정에서 뺄 트리거 키 (TRD §9.2) */
  recentlyResumed: ReadonlySet<string>;
}

/** 조건 성립(대상 포함), 해소, 또는 판정 불가(`null`, 열린 알림을 그대로 둔다) */
export type RuleEvaluation = { firing: true; affected: AlertAffected } | { firing: false } | null;

const CLEAR = { firing: false } as const;

function triggersAffected(items: AlertTriggerItem[], total = items.length): RuleEvaluation {
  if (total === 0) return CLEAR;
  return {
    firing: true,
    affected: { kind: 'triggers', total, triggers: items.slice(0, ALERT_AFFECTED_MAX) },
  };
}

export function evaluateRule(rule: AlertRuleSpec, input: EvaluationInput): RuleEvaluation {
  const { result } = input;
  if (rule.type === 'MONITOR_UNREACHABLE') {
    if (result.ok) return CLEAR;
    const failures = rule.params.failures ?? UNREACHABLE_FAILURES_DEFAULT;
    if (result.consecutiveFailures < failures) return null;
    return {
      firing: true,
      affected: {
        kind: 'monitor',
        failures: result.consecutiveFailures,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      },
    };
  }
  // 감시가 실패한 회차에는 대상 DB 상태를 모른다
  if (!result.ok) return null;
  const { data } = result;

  switch (rule.type) {
    case 'OVERDUE': {
      const listed = data.overdue.filter(
        (t) => inScope(rule.scope, t) && !input.recentlyResumed.has(triggerKeyOf(t)),
      );
      const items = listed.map(({ group, name, nextFireTime }) => ({ group, name, nextFireTime }));
      // 전체 범위면 목록 상한을 넘은 연체도 센다. 목록에서 뺀 재개 트리거만큼 줄인다
      const excluded = data.overdue.length - listed.length;
      const total =
        rule.scope.kind === 'all'
          ? Math.max(data.overdueCount - excluded, items.length)
          : items.length;
      return triggersAffected(items, total);
    }
    case 'TRIGGER_ERROR':
      return triggersAffected(
        data.errorTriggers
          .filter((t) => inScope(rule.scope, t))
          .map(({ group, name }) => ({ group, name })),
      );
    case 'BLOCKED_LONG': {
      const minutes = rule.params.minutes ?? BLOCKED_MINUTES_DEFAULT;
      const before = data.dbNow - minutes * 60_000;
      const items: AlertTriggerItem[] = [];
      for (const t of data.blockedTriggers) {
        // PAUSED_BLOCKED는 일시정지한 트리거라 알리지 않는다(OVERDUE가 일시정지를 빼는 것과 같음)
        if (t.state !== 'BLOCKED' || !inScope(rule.scope, t)) continue;
        const since = input.blockedSince.get(triggerKeyOf(t));
        if (since !== undefined && since <= before) {
          items.push({ group: t.group, name: t.name, state: t.state, since });
        }
      }
      return triggersAffected(items.sort((a, b) => (a.since ?? 0) - (b.since ?? 0)));
    }
    case 'NODE_MISSING':
    case 'CLUSTER_DOWN': {
      const active = data.nodes.filter((n) => n.active).length;
      const firing = rule.type === 'CLUSTER_DOWN' ? active === 0 : active < input.expectedNodeCount;
      if (!firing) return CLEAR;
      return {
        firing: true,
        affected: {
          kind: 'nodes',
          active,
          expected: input.expectedNodeCount,
          nodes: data.nodes.map((n) => ({
            instanceName: n.instanceName,
            active: n.active,
            lastCheckinTime: n.lastCheckinTime,
          })),
        },
      };
    }
  }
}

// ── 수명주기 ─────────────────────────────────────────────────────

export interface OpenAlertState {
  status: 'open' | 'acked';
  affected: AlertAffected | null;
  /** 마지막으로 발송한 시각(도구 서버 시각). 한 번도 발송하지 않았으면 null */
  lastNotifiedAt: number | null;
}

export interface AlertStepOptions {
  /** 도구 서버 시각 */
  now: number;
  renotifyMinutes: number | null;
  /** 억제 중이면 상태만 기록하고 발송하지 않는다 (FR-ALT-09) */
  suppressed: boolean;
}

export type AlertStep =
  | { action: 'none' }
  | { action: 'open'; affected: AlertAffected; notify: NotificationEvent | null }
  | { action: 'refresh'; affected: AlertAffected; notify: NotificationEvent | null }
  | { action: 'resolve'; notify: NotificationEvent | null };

/**
 * "새 항목"을 가리는 키. 트리거 알림은 트리거, 노드 알림은 빠진 노드 수(1..n)라서 더 빠지면 새 키가 생기고
 * 돌아오면 키가 줄어든다. 감시 불가 알림은 갱신 발송이 없다.
 */
export function affectedKeys(affected: AlertAffected | null): string[] {
  if (!affected) return [];
  switch (affected.kind) {
    case 'triggers':
      return affected.triggers.map(triggerKeyOf);
    case 'nodes':
      return Array.from(
        { length: Math.max(affected.expected - affected.active, 0) },
        (_, i) => `missing:${i + 1}`,
      );
    case 'monitor':
      return [];
  }
}

/**
 * 알림 하나의 다음 단계 (TRD §9.3).
 *
 * - 조건 성립, 열린 알림 없음 → open, `fire`
 * - 조건 성립, 열린 알림 있음 → 대상·마지막 관찰 갱신. 아직 발송하지 않았으면(억제가 풀림) `fire`,
 *   대상에 새 항목이 있으면 `update`, 확인 전이고 재알림 간격이 지났으면 `reminder`
 * - 조건 해소 → resolved. 발송한 적이 있으면 `resolve`
 * - 억제 중이면 상태는 바꾸되 무엇도 발송하지 않는다
 */
export function stepAlert(
  existing: OpenAlertState | null,
  evaluation: RuleEvaluation,
  opts: AlertStepOptions,
): AlertStep {
  if (evaluation === null) return { action: 'none' };
  if (!evaluation.firing) {
    if (!existing) return { action: 'none' };
    return {
      action: 'resolve',
      notify: existing.lastNotifiedAt !== null && !opts.suppressed ? 'resolve' : null,
    };
  }
  const { affected } = evaluation;
  if (!existing) return { action: 'open', affected, notify: opts.suppressed ? null : 'fire' };
  let notify: NotificationEvent | null = null;
  if (!opts.suppressed) {
    if (existing.lastNotifiedAt === null) notify = 'fire';
    else {
      const before = new Set(affectedKeys(existing.affected));
      if (affectedKeys(affected).some((k) => !before.has(k))) notify = 'update';
      else if (
        existing.status === 'open' &&
        opts.renotifyMinutes !== null &&
        opts.now - existing.lastNotifiedAt >= opts.renotifyMinutes * 60_000
      ) {
        notify = 'reminder';
      }
    }
  }
  return { action: 'refresh', affected, notify };
}
