import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ALERT_CENTER_PAGE_SIZE,
  DELIVERY_FAILURE_WINDOW_MS,
  SUPPRESSED_RULE_TYPES,
  SUPPRESSING_RULE_TYPES,
  type AlertAffected,
  type AlertCenterItemDto,
  type AlertCenterPage,
  type AlertCenterQuery,
  type AlertRuleType,
  type AlertStatus,
  type AlertSummaryDto,
  type DeliveryFailureDto,
  type NotificationEvent,
  type Severity,
} from '@qa/shared';
import { ApiError, notFound } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { MaintenanceService } from '../meta-db/maintenance.service.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';

const DAY = 86_400_000;

/**
 * 이 사용자가 인앱으로 받고 아직 읽지 않았는지. 인앱 채널로 나간(큐에 들어간) 발송 중 마지막으로 읽은 뒤의 것이
 * 있으면 읽지 않은 것이다. 억제돼 한 번도 보내지 않은 알림은 세지 않는다
 */
const UNREAD = `EXISTS (
  SELECT 1 FROM notifications n JOIN channels c ON c.id = n.channel_id AND c.type = 'inapp'
  WHERE n.alert_id = a.id
    AND n.created_at > COALESCE(
      (SELECT r.read_at FROM alert_reads r WHERE r.alert_id = a.id AND r.user_id = @userId), -1)
)`;

const STATUS_WHERE: Record<AlertCenterQuery['status'], string> = {
  active: `a.status <> 'resolved'`,
  resolved: `a.status = 'resolved'`,
  all: '1 = 1',
};

/** 해소 전은 심각도 높은 순·최근 순, 해소는 해소 시각 최근 순 */
const ORDER_BY = `CASE WHEN a.status = 'resolved' THEN 1 ELSE 0 END,
  CASE WHEN a.status = 'resolved' THEN 0 ELSE CASE a.severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END END DESC,
  COALESCE(a.resolved_at, a.first_seen_at) DESC, a.id DESC`;

interface AlertRowRaw {
  id: number;
  scheduler_id: number;
  rule_id: number | null;
  type: AlertRuleType;
  severity: Severity;
  status: AlertStatus;
  affected: string | null;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  acked_at: number | null;
  last_notified_at: number | null;
  scheduler_name: string;
  env_label: string | null;
  acked_by_name: string | null;
  unread: 0 | 1;
}

/** 인앱 알림 센터 (FR-ALT-07, TRD §9.4): 모든 스케줄러의 알림, 읽음(사용자별), 확인(ack), 발송 실패 */
@Injectable()
export class AlertCenterService implements OnModuleInit {
  constructor(
    private readonly metaDb: MetaDbService,
    private readonly maintenance: MaintenanceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    // 해소된 알림(발송 기록·읽음 포함)과 끝난 발송 기록을 보존 기간 뒤 지운다 (TRD §3.3)
    this.maintenance.register({ name: 'alerts', run: (now) => this.prune(now) });
  }

  list(userId: number, query: AlertCenterQuery): AlertCenterPage {
    const db = this.metaDb.sqlite;
    const where = STATUS_WHERE[query.status];
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM alerts a WHERE ${where}`).get() as { n: number }
    ).n;
    const rows = db
      .prepare(
        `SELECT a.*, s.display_name AS scheduler_name, k.env_label AS env_label,
                u.username AS acked_by_name, ${UNREAD} AS unread
         FROM alerts a
         JOIN schedulers s ON s.id = a.scheduler_id
         JOIN connections k ON k.id = s.connection_id
         LEFT JOIN users u ON u.id = a.acked_by
         WHERE ${where}
         ORDER BY ${ORDER_BY}
         LIMIT @limit OFFSET @offset`,
      )
      .all({
        userId,
        limit: ALERT_CENTER_PAGE_SIZE,
        offset: (query.page - 1) * ALERT_CENTER_PAGE_SIZE,
      }) as AlertRowRaw[];
    const suppressing = this.suppressingSchedulers();
    return {
      items: rows.map((r) => this.toDto(r, suppressing)),
      total,
      page: query.page,
      pageSize: ALERT_CENTER_PAGE_SIZE,
    };
  }

  summary(userId: number): AlertSummaryDto {
    const db = this.metaDb.sqlite;
    const unread = (
      db.prepare(`SELECT COUNT(*) AS n FROM alerts a WHERE ${UNREAD}`).get({ userId }) as {
        n: number;
      }
    ).n;
    const open = (
      db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE status <> 'resolved'`).get() as {
        n: number;
      }
    ).n;
    const failedDeliveries = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed' AND next_attempt_at >= ?`,
        )
        .get(this.clock() - DELIVERY_FAILURE_WINDOW_MS) as { n: number }
    ).n;
    return { unread, open, failedDeliveries };
  }

  markRead(userId: number, alertId: number): void {
    this.requireAlert(alertId);
    this.metaDb.sqlite
      .prepare(
        `INSERT INTO alert_reads (alert_id, user_id, read_at) VALUES (?, ?, ?)
         ON CONFLICT (alert_id, user_id) DO UPDATE SET read_at = excluded.read_at`,
      )
      .run(alertId, userId, this.clock());
  }

  /** 읽지 않은 알림을 모두 읽음으로. 바뀐 수를 돌려준다 */
  markAllRead(userId: number): number {
    return this.metaDb.sqlite
      .prepare(
        `INSERT INTO alert_reads (alert_id, user_id, read_at)
         SELECT a.id, @userId, @now FROM alerts a WHERE ${UNREAD}
         ON CONFLICT (alert_id, user_id) DO UPDATE SET read_at = excluded.read_at`,
      )
      .run({ userId, now: this.clock() }).changes;
  }

  /**
   * 확인(ack): 재알림을 멈춘다. 해소 알림은 그대로 보낸다 (TRD §9.3). 확인하면 읽음으로도 둔다.
   * 이미 확인했으면 바꾸지 않는다. 해소된 알림은 확인할 수 없다(409)
   */
  ack(userId: number, alertId: number): { changed: boolean; status: AlertStatus } {
    const alert = this.requireAlert(alertId);
    if (alert.status === 'resolved') {
      throw new ApiError(HttpStatus.CONFLICT, 'OPERATION_NOT_ALLOWED', '이미 해소된 알림입니다');
    }
    const changed =
      alert.status === 'open' &&
      this.metaDb.sqlite
        .prepare(
          `UPDATE alerts SET status = 'acked', acked_by = ?, acked_at = ? WHERE id = ? AND status = 'open'`,
        )
        .run(userId, this.clock(), alertId).changes > 0;
    this.markRead(userId, alertId);
    return { changed, status: 'acked' };
  }

  /** 감사 기록용 알림 요약 */
  describe(alertId: number): { id: number; schedulerId: number; type: AlertRuleType } | undefined {
    const row = this.metaDb.sqlite
      .prepare('SELECT id, scheduler_id, type FROM alerts WHERE id = ?')
      .get(alertId) as { id: number; scheduler_id: number; type: AlertRuleType } | undefined;
    return row ? { id: row.id, schedulerId: row.scheduler_id, type: row.type } : undefined;
  }

  /** 최근 끝내 보내지 못한 발송 (최근 순 50개) */
  deliveryFailures(): DeliveryFailureDto[] {
    const rows = this.metaDb.sqlite
      .prepare(
        `SELECT n.id, n.alert_id, a.type AS alert_type, a.scheduler_id, s.display_name AS scheduler_name,
                n.channel_id, c.name AS channel_name, n.event, n.attempts, n.last_error, n.created_at
         FROM notifications n
         JOIN alerts a ON a.id = n.alert_id
         JOIN schedulers s ON s.id = a.scheduler_id
         JOIN channels c ON c.id = n.channel_id
         WHERE n.status = 'failed' AND n.next_attempt_at >= ?
         ORDER BY n.id DESC LIMIT 50`,
      )
      .all(this.clock() - DELIVERY_FAILURE_WINDOW_MS) as {
      id: number;
      alert_id: number;
      alert_type: AlertRuleType;
      scheduler_id: number;
      scheduler_name: string;
      channel_id: number;
      channel_name: string;
      event: NotificationEvent;
      attempts: number;
      last_error: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      alertId: r.alert_id,
      alertType: r.alert_type,
      schedulerId: r.scheduler_id,
      schedulerName: r.scheduler_name,
      channelId: r.channel_id,
      channelName: r.channel_name,
      event: r.event,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
    }));
  }

  /** 보존 정리. 지운 행 수 */
  prune(now: number): number {
    const cutoff = now - this.config.alertRetentionDays * DAY;
    const db = this.metaDb.sqlite;
    return db.transaction(() => {
      const done = db
        .prepare(`DELETE FROM notifications WHERE status <> 'pending' AND next_attempt_at < ?`)
        .run(cutoff).changes;
      const resolved = db
        .prepare(`DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < ?`)
        .run(cutoff).changes;
      return done + resolved;
    })();
  }

  private requireAlert(alertId: number): { status: AlertStatus } {
    const row = this.metaDb.sqlite
      .prepare('SELECT status FROM alerts WHERE id = ?')
      .get(alertId) as { status: AlertStatus } | undefined;
    if (!row) throw notFound('알림을 찾을 수 없습니다');
    return row;
  }

  private suppressingSchedulers(): Set<number> {
    const types = SUPPRESSING_RULE_TYPES.map((t) => `'${t}'`).join(', ');
    const rows = this.metaDb.sqlite
      .prepare(
        `SELECT DISTINCT scheduler_id FROM alerts WHERE status <> 'resolved' AND type IN (${types})`,
      )
      .all() as { scheduler_id: number }[];
    return new Set(rows.map((r) => r.scheduler_id));
  }

  private toDto(r: AlertRowRaw, suppressing: Set<number>): AlertCenterItemDto {
    return {
      id: r.id,
      schedulerId: r.scheduler_id,
      ruleId: r.rule_id,
      type: r.type,
      severity: r.severity,
      status: r.status,
      affected: r.affected ? (JSON.parse(r.affected) as AlertAffected) : null,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      resolvedAt: r.resolved_at,
      ackedAt: r.acked_at,
      notified: r.last_notified_at !== null,
      suppressed:
        r.status !== 'resolved' &&
        suppressing.has(r.scheduler_id) &&
        (SUPPRESSED_RULE_TYPES as readonly string[]).includes(r.type),
      schedulerName: r.scheduler_name,
      envLabel: r.env_label,
      unread: r.unread === 1,
      ackedBy: r.acked_by_name,
    };
  }
}
