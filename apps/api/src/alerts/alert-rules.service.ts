import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  ALERT_RESOLVED_LISTED,
  SEVERITIES,
  SUPPRESSED_RULE_TYPES,
  SUPPRESSING_RULE_TYPES,
  type AlertDto,
  type AlertRuleDto,
  type AlertRuleInput,
  type SchedulerAlertsResponse,
} from '@qa/shared';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { ApiError, notFound } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { alertRuleChannels, alertRules, alerts, schedulers } from '../meta-db/schema.js';
import { AlertDefaults } from './alert-defaults.js';

type RuleRow = typeof alertRules.$inferSelect;
type AlertRow = typeof alerts.$inferSelect;

/** 규칙 화면과 감사 기록에 남기는 규칙 값 */
export function alertRuleView(
  row: RuleRow,
): Omit<AlertRuleDto, 'channelIds' | 'createdAt' | 'updatedAt'> {
  return {
    id: row.id,
    schedulerId: row.schedulerId,
    type: row.type,
    params: row.params,
    scope: row.scope,
    severity: row.severity,
    renotifyMinutes: row.renotifyMinutes,
    enabled: row.enabled,
  };
}

const severityRank = (s: AlertRow['severity']) => SEVERITIES.indexOf(s);

/** 알림 규칙 관리와 스케줄러의 알림 목록 (FR-ALT-06, TRD §9.2) */
@Injectable()
export class AlertRulesService {
  constructor(
    private readonly metaDb: MetaDbService,
    private readonly defaults: AlertDefaults,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(schedulerId: number): AlertRuleDto[] {
    this.requireScheduler(schedulerId);
    const rows = this.metaDb.db
      .select()
      .from(alertRules)
      .where(eq(alertRules.schedulerId, schedulerId))
      .orderBy(alertRules.id)
      .all();
    const links = this.channelLinks(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, links));
  }

  find(id: number): RuleRow | undefined {
    return this.metaDb.db.select().from(alertRules).where(eq(alertRules.id, id)).get();
  }

  get(id: number): AlertRuleDto {
    const row = this.find(id);
    if (!row) throw notFound('알림 규칙을 찾을 수 없습니다');
    return this.toDto(row, this.channelLinks([id]));
  }

  /** 새 규칙은 인앱 채널에 연결한다. 채널 선택은 B-25 */
  create(schedulerId: number, input: AlertRuleInput): AlertRuleDto {
    this.requireScheduler(schedulerId);
    const now = this.clock();
    const id = this.metaDb.db.transaction((tx) => {
      const row = tx
        .insert(alertRules)
        .values({ schedulerId, ...input, createdAt: now, updatedAt: now })
        .returning({ id: alertRules.id })
        .get();
      this.defaults.linkInapp(tx, row.id);
      return row.id;
    });
    return this.get(id);
  }

  /**
   * 규칙 타입은 바꾸지 않는다(대상 목록과 지문이 타입마다 달라서). 바뀐 값은 다음 감시 회차부터 반영되고,
   * 끈 규칙의 열린 알림은 그때 발송 없이 해소된다
   */
  update(id: number, input: AlertRuleInput): AlertRuleDto {
    const current = this.find(id);
    if (!current) throw notFound('알림 규칙을 찾을 수 없습니다');
    if (current.type !== input.type) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        '규칙 타입은 바꿀 수 없습니다',
        [{ path: 'type', message: '규칙 타입은 바꿀 수 없습니다' }],
      );
    }
    this.metaDb.db
      .update(alertRules)
      .set({ ...input, updatedAt: this.clock() })
      .where(eq(alertRules.id, id))
      .run();
    return this.get(id);
  }

  /** 지운 규칙의 열린 알림은 바로 해소한다(발송 없음). 알림 기록은 규칙 없이 남는다 */
  delete(id: number): RuleRow {
    const current = this.find(id);
    if (!current) throw notFound('알림 규칙을 찾을 수 없습니다');
    const now = this.clock();
    this.metaDb.db.transaction((tx) => {
      tx.update(alerts)
        .set({ status: 'resolved', resolvedAt: now })
        .where(and(eq(alerts.ruleId, id), ne(alerts.status, 'resolved')))
        .run();
      tx.delete(alertRules).where(eq(alertRules.id, id)).run();
    });
    return current;
  }

  /** 해소 전 알림과 최근 해소된 알림 */
  alerts(schedulerId: number): SchedulerAlertsResponse {
    this.requireScheduler(schedulerId);
    const open = this.metaDb.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.schedulerId, schedulerId), ne(alerts.status, 'resolved')))
      .all()
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.firstSeenAt - a.firstSeenAt ||
          b.id - a.id,
      );
    const resolved = this.metaDb.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.schedulerId, schedulerId), eq(alerts.status, 'resolved')))
      .orderBy(desc(alerts.resolvedAt), desc(alerts.id))
      .limit(ALERT_RESOLVED_LISTED)
      .all();
    const suppressing = open.some((a) =>
      (SUPPRESSING_RULE_TYPES as readonly string[]).includes(a.type),
    );
    const toDto = (a: AlertRow): AlertDto => ({
      id: a.id,
      schedulerId: a.schedulerId,
      ruleId: a.ruleId,
      type: a.type,
      severity: a.severity,
      status: a.status,
      affected: a.affected ?? null,
      firstSeenAt: a.firstSeenAt,
      lastSeenAt: a.lastSeenAt,
      resolvedAt: a.resolvedAt,
      ackedAt: a.ackedAt,
      notified: a.lastNotifiedAt !== null,
      suppressed:
        a.status !== 'resolved' &&
        suppressing &&
        (SUPPRESSED_RULE_TYPES as readonly string[]).includes(a.type),
    });
    return { open: open.map(toDto), resolved: resolved.map(toDto) };
  }

  private requireScheduler(id: number): void {
    const row = this.metaDb.db
      .select({ id: schedulers.id })
      .from(schedulers)
      .where(eq(schedulers.id, id))
      .get();
    if (!row) throw notFound('스케줄러를 찾을 수 없습니다');
  }

  private channelLinks(ruleIds: number[]): Map<number, number[]> {
    const map = new Map<number, number[]>();
    if (ruleIds.length === 0) return map;
    const rows = this.metaDb.db
      .select()
      .from(alertRuleChannels)
      .where(inArray(alertRuleChannels.ruleId, ruleIds))
      .orderBy(alertRuleChannels.channelId)
      .all();
    for (const r of rows) map.set(r.ruleId, [...(map.get(r.ruleId) ?? []), r.channelId]);
    return map;
  }

  private toDto(row: RuleRow, links: Map<number, number[]>): AlertRuleDto {
    return {
      ...alertRuleView(row),
      channelIds: links.get(row.id) ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
