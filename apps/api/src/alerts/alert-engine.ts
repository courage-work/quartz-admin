import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  SUPPRESSED_RULE_TYPES,
  SUPPRESSING_RULE_TYPES,
  type AlertRuleType,
  type AuditAction,
  type CommandChangeDto,
  type NotificationEvent,
} from '@qa/shared';
import {
  evaluateRule,
  observeBlocked,
  stepAlert,
  triggerKeyOf,
  type AlertStep,
  type MonitorResult,
} from '@qa/store';
import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock.js';
import {
  alertRuleChannels,
  alertRules,
  alerts,
  auditLogs,
  channels,
  notifications,
  triggerObservations,
} from '../meta-db/schema.js';
import {
  MonitorHooks,
  type MonitorHook,
  type MonitorOutcome,
  type MonitorTx,
} from '../monitor/monitor-hooks.js';

type RuleRow = typeof alertRules.$inferSelect;
type AlertRow = typeof alerts.$inferSelect;

/** 연체 판정에서 뺄 "도구가 재개한 트리거"를 찾는 감사 작업 종류 (TRD §9.2) */
const RESUME_ACTIONS: AuditAction[] = [
  'trigger.resume',
  'job.resume',
  'trigger_group.resume',
  'job_group.resume',
];

const isSuppressing = (t: AlertRuleType) =>
  (SUPPRESSING_RULE_TYPES as readonly string[]).includes(t);
const isSuppressed = (t: AlertRuleType) => (SUPPRESSED_RULE_TYPES as readonly string[]).includes(t);

/**
 * 알림 규칙 엔진 (TRD §9.2, §9.3, B-24). 감시 1회의 SQLite 트랜잭션 안에서(`MonitorHooks`) 규칙을 판정하고
 * 알림 상태와 `trigger_observations`를 갱신한 뒤, 발송할 일을 `notifications`(outbox)에 넣는다. 발송은 B-25의 워커가 한다.
 *
 * - 억제(FR-ALT-09): `CLUSTER_DOWN`·`MONITOR_UNREACHABLE`을 먼저 판정하고, 그 알림이 열려 있으면 같은 스케줄러의
 *   `OVERDUE`·`BLOCKED_LONG`·`NODE_MISSING`은 상태만 기록한다. 억제가 풀린 뒤에도 열려 있으면 그때 `fire`를 보낸다
 * - 감시가 실패한 회차에는 `MONITOR_UNREACHABLE`만 판정하고 나머지 알림은 그대로 둔다
 * - 지우거나 끈 규칙, 타입이 바뀐 규칙의 열린 알림은 발송 없이 해소한다
 */
@Injectable()
export class AlertEngine implements MonitorHook, OnModuleInit {
  readonly name = 'alert-engine';

  constructor(
    private readonly hooks: MonitorHooks,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.hooks.register(this);
  }

  afterPoll(outcome: MonitorOutcome, tx: MonitorTx): void {
    const now = this.clock();
    const { scheduler } = outcome;
    const rules = tx
      .select()
      .from(alertRules)
      .where(eq(alertRules.schedulerId, scheduler.id))
      .all();
    const open = tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.schedulerId, scheduler.id), ne(alerts.status, 'resolved')))
      .all();

    let result: MonitorResult;
    let blockedSince = new Map<string, number>();
    if (outcome.ok) {
      result = { ok: true, data: outcome.data };
      blockedSince = this.observe(tx, scheduler.id, outcome);
    } else {
      result = {
        ok: false,
        consecutiveFailures: outcome.snapshot.consecutiveFailures,
        errorCode: outcome.snapshot.errorCode,
        errorMessage: outcome.snapshot.errorMessage,
      };
    }

    const enabled = rules.filter((r) => r.enabled);
    const recentlyResumed =
      outcome.ok && enabled.some((r) => r.type === 'OVERDUE')
        ? this.recentlyResumed(
            tx,
            scheduler.id,
            now - (scheduler.misfireThresholdMs + scheduler.overdueGraceMs),
          )
        : new Set<string>();

    const byId = new Map(rules.map((r) => [r.id, r]));
    const openByRule = new Map<number, AlertRow>();
    for (const a of open) {
      const rule = a.ruleId === null ? undefined : byId.get(a.ruleId);
      if (!rule || !rule.enabled || rule.type !== a.type) {
        tx.update(alerts)
          .set({ status: 'resolved', resolvedAt: now })
          .where(eq(alerts.id, a.id))
          .run();
      } else {
        openByRule.set(rule.id, a);
      }
    }

    const input = {
      result,
      expectedNodeCount: scheduler.expectedNodeCount,
      blockedSince,
      recentlyResumed,
    };
    const run = (rule: RuleRow, suppressed: boolean): boolean => {
      const existing = openByRule.get(rule.id) ?? null;
      const step = stepAlert(
        existing && {
          // 열린 알림만 골랐으므로 resolved가 아니다
          status: existing.status === 'acked' ? 'acked' : 'open',
          affected: existing.affected ?? null,
          lastNotifiedAt: existing.lastNotifiedAt,
        },
        evaluateRule(rule, input),
        { now, renotifyMinutes: rule.renotifyMinutes, suppressed },
      );
      return this.apply(tx, scheduler.id, rule, existing, step, now);
    };

    // 억제하는 규칙을 먼저 판정해 이번 회차의 억제 여부를 정한다
    let suppressing = false;
    for (const rule of enabled.filter((r) => isSuppressing(r.type))) {
      if (run(rule, false)) suppressing = true;
    }
    for (const rule of enabled.filter((r) => !isSuppressing(r.type))) {
      run(rule, suppressing && isSuppressed(rule.type));
    }
  }

  /** BLOCKED 관찰을 갱신하고 트리거별 처음 본 시각을 돌려준다 */
  private observe(
    tx: MonitorTx,
    schedulerId: number,
    outcome: Extract<MonitorOutcome, { ok: true }>,
  ): Map<string, number> {
    const previous = tx
      .select()
      .from(triggerObservations)
      .where(eq(triggerObservations.schedulerId, schedulerId))
      .all()
      .map((o) => ({
        group: o.triggerGroup,
        name: o.triggerName,
        state: o.state,
        firstSeenAt: o.firstSeenAt,
      }));
    const update = observeBlocked(previous, outcome.data.blockedTriggers, outcome.data.dbNow);
    for (const t of update.removed) {
      tx.delete(triggerObservations)
        .where(
          and(
            eq(triggerObservations.schedulerId, schedulerId),
            eq(triggerObservations.triggerGroup, t.group),
            eq(triggerObservations.triggerName, t.name),
          ),
        )
        .run();
    }
    for (const o of update.upserts) {
      tx.insert(triggerObservations)
        .values({
          schedulerId,
          triggerGroup: o.group,
          triggerName: o.name,
          state: o.state,
          firstSeenAt: o.firstSeenAt,
        })
        .onConflictDoUpdate({
          target: [
            triggerObservations.schedulerId,
            triggerObservations.triggerGroup,
            triggerObservations.triggerName,
          ],
          set: { state: o.state, firstSeenAt: o.firstSeenAt },
        })
        .run();
    }
    return new Map(update.next.map((o) => [triggerKeyOf(o), o.firstSeenAt]));
  }

  /** `since` 뒤에 도구가 재개해 바뀐 트리거 (감사 로그의 `after.changes`) */
  private recentlyResumed(tx: MonitorTx, schedulerId: number, since: number): Set<string> {
    const rows = tx
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.schedulerId, schedulerId),
          gte(auditLogs.at, since),
          eq(auditLogs.result, 'success'),
          inArray(auditLogs.action, RESUME_ACTIONS),
        ),
      )
      .all();
    const keys = new Set<string>();
    for (const { after } of rows) {
      const changes = (after as { changes?: CommandChangeDto[] } | null)?.changes;
      if (!Array.isArray(changes)) continue;
      for (const c of changes) {
        if (typeof c?.group === 'string' && typeof c.name === 'string') keys.add(triggerKeyOf(c));
      }
    }
    return keys;
  }

  /** 단계를 반영하고, 이번 회차 뒤에 알림이 열려 있으면 true */
  private apply(
    tx: MonitorTx,
    schedulerId: number,
    rule: RuleRow,
    existing: AlertRow | null,
    step: AlertStep,
    now: number,
  ): boolean {
    switch (step.action) {
      case 'none':
        return existing !== null;
      case 'open': {
        const row = tx
          .insert(alerts)
          .values({
            schedulerId,
            ruleId: rule.id,
            fingerprint: rule.type,
            type: rule.type,
            severity: rule.severity,
            status: 'open',
            affected: step.affected,
            firstSeenAt: now,
            lastSeenAt: now,
            lastNotifiedAt: step.notify ? now : null,
          })
          .returning({ id: alerts.id })
          .get();
        if (step.notify) this.enqueue(tx, rule.id, row.id, step.notify, now);
        return true;
      }
      case 'refresh': {
        tx.update(alerts)
          .set({
            affected: step.affected,
            severity: rule.severity,
            lastSeenAt: now,
            ...(step.notify ? { lastNotifiedAt: now } : {}),
          })
          .where(eq(alerts.id, existing!.id))
          .run();
        if (step.notify) this.enqueue(tx, rule.id, existing!.id, step.notify, now);
        return true;
      }
      case 'resolve':
        // 해소 알림도 발송이다. 알림 센터가 읽지 않은 알림으로 센다
        tx.update(alerts)
          .set({
            status: 'resolved',
            resolvedAt: now,
            ...(step.notify ? { lastNotifiedAt: now } : {}),
          })
          .where(eq(alerts.id, existing!.id))
          .run();
        if (step.notify) this.enqueue(tx, rule.id, existing!.id, step.notify, now);
        return false;
    }
  }

  /** 규칙에 연결된 켜진 채널마다 발송 큐에 넣는다 (TRD §9.4) */
  private enqueue(
    tx: MonitorTx,
    ruleId: number,
    alertId: number,
    event: NotificationEvent,
    now: number,
  ): void {
    const targets = tx
      .select({ id: channels.id })
      .from(alertRuleChannels)
      .innerJoin(channels, eq(channels.id, alertRuleChannels.channelId))
      .where(and(eq(alertRuleChannels.ruleId, ruleId), eq(channels.enabled, true)))
      .all();
    for (const c of targets) {
      tx.insert(notifications)
        .values({ alertId, channelId: c.id, event, nextAttemptAt: now, createdAt: now })
        .run();
    }
  }
}
