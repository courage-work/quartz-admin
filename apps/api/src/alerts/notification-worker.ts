import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { AlertAffected, AlertRuleType, NotificationEvent, Severity } from '@qa/shared';
import { and, asc, eq, lte } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { alerts, connections, notifications, schedulers } from '../meta-db/schema.js';
import { ChannelsService } from './channels.service.js';
import { emailContent, slackPayload, type OutboundItem } from './messages.js';
import { SendError, Senders } from './senders.js';

export const NOTIFIER_OPTIONS = Symbol('NOTIFIER_OPTIONS');

export interface NotifierOptions {
  /** false면 기동 시 워커를 돌리지 않는다(API 테스트는 `tick()`을 직접 부른다). 기본 true */
  enabled: boolean;
  /** 처리 주기. 기본 5초 (TRD §9.4) */
  intervalMs: number;
  /** 한 번 보낼 때 기다리는 시간. 기본 10초 */
  sendTimeoutMs: number;
}

/** 실패한 뒤 다시 시도할 때까지 기다리는 시간. 네 번째 시도가 실패하면 `failed` (TRD §9.4) */
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;
/** 한 회차에 같은 채널로 나갈 발송이 이보다 많으면 요약 하나로 묶는다 (TRD §9.3) */
export const SUMMARY_THRESHOLD = 5;
/** 한 회차에 꺼내는 발송 수 */
const BATCH_LIMIT = 200;

interface DueRow {
  id: number;
  attempts: number;
  event: NotificationEvent;
  channelId: number;
  alert: { id: number; type: AlertRuleType; severity: Severity; affected: AlertAffected | null };
  scheduler: { id: number; displayName: string };
  envLabel: string | null;
}

export interface TickReport {
  sent: number;
  retried: number;
  failed: number;
}

/**
 * 발송 큐 워커 (TRD §9.4, B-25). `notifications`를 outbox로 써서 5초마다 시각이 된 발송을 꺼내 채널마다 보낸다.
 *
 * - 감시 루프와 따로 돈다. 보내는 동안 SQLite를 잡고 있지 않고, 한 번 보낼 때 10초까지만 기다리므로
 *   Slack이나 SMTP가 멈춰도 감시는 밀리지 않는다
 * - 실패하면 30초, 2분, 10분 뒤 다시 시도하고 네 번째도 실패하면 `failed`로 둔다
 * - 인앱은 보낼 것이 없어 바로 `sent`로 둔다. 인앱 알림은 알림 센터가 발송 기록으로 읽는다
 * - 같은 채널로 나갈 것이 한 회차에 5건을 넘으면 요약 메시지 하나로 보낸다
 * - 끝난 발송의 `next_attempt_at`은 마지막으로 시도한 시각이다
 */
@Injectable()
export class NotificationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<TickReport> | undefined;

  constructor(
    private readonly metaDb: MetaDbService,
    private readonly channels: ChannelsService,
    private readonly senders: Senders,
    @Inject(NOTIFIER_OPTIONS) private readonly options: NotifierOptions,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) =>
        this.logger.error(`발송 처리 실패: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, this.options.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** 한 회차. 앞 회차가 아직 돌고 있으면 그 결과를 기다린다(겹쳐 돌리지 않음) */
  tick(): Promise<TickReport> {
    this.running ??= this.process().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async process(): Promise<TickReport> {
    const report: TickReport = { sent: 0, retried: 0, failed: 0 };
    const due = this.due(this.clock());
    if (due.length === 0) return report;
    const byChannel = new Map<number, DueRow[]>();
    for (const row of due)
      byChannel.set(row.channelId, [...(byChannel.get(row.channelId) ?? []), row]);
    await Promise.all(
      [...byChannel].map(([channelId, rows]) => this.deliver(channelId, rows, report)),
    );
    return report;
  }

  private async deliver(channelId: number, rows: DueRow[], report: TickReport): Promise<void> {
    const channel = this.channels.find(channelId);
    if (!channel || !channel.row.enabled) {
      this.finish(rows, 'failed', '채널이 꺼져 있거나 없어서 보내지 않았습니다', report);
      return;
    }
    if (channel.row.type === 'inapp') {
      this.finish(rows, 'sent', null, report);
      return;
    }
    const batches = rows.length > SUMMARY_THRESHOLD ? [rows] : rows.map((r) => [r]);
    for (const batch of batches) {
      const items: OutboundItem[] = batch.map((r) => ({
        event: r.event,
        alert: r.alert,
        scheduler: r.scheduler,
        envLabel: r.envLabel,
      }));
      try {
        if (channel.row.type === 'slack') {
          await this.senders.slack(
            channel.config.webhookUrl ?? '',
            slackPayload(items, this.config.publicUrl),
            this.options.sendTimeoutMs,
          );
        } else {
          await this.senders.email(
            channel.config.recipients ?? [],
            emailContent(items, this.config.publicUrl),
            this.options.sendTimeoutMs,
          );
        }
        this.finish(batch, 'sent', null, report);
      } catch (err) {
        const message =
          err instanceof SendError ? err.message : '보내는 중 처리하지 못한 오류가 났습니다';
        if (!(err instanceof SendError))
          this.logger.error(`발송 중 오류 (채널 ${channelId}): ${String(err)}`);
        this.retryOrFail(batch, message, report);
      }
    }
  }

  private due(now: number): DueRow[] {
    return this.metaDb.db
      .select({
        id: notifications.id,
        attempts: notifications.attempts,
        event: notifications.event,
        channelId: notifications.channelId,
        alertId: alerts.id,
        type: alerts.type,
        severity: alerts.severity,
        affected: alerts.affected,
        schedulerId: schedulers.id,
        displayName: schedulers.displayName,
        envLabel: connections.envLabel,
      })
      .from(notifications)
      .innerJoin(alerts, eq(alerts.id, notifications.alertId))
      .innerJoin(schedulers, eq(schedulers.id, alerts.schedulerId))
      .innerJoin(connections, eq(connections.id, schedulers.connectionId))
      .where(and(eq(notifications.status, 'pending'), lte(notifications.nextAttemptAt, now)))
      .orderBy(asc(notifications.id))
      .limit(BATCH_LIMIT)
      .all()
      .map((r) => ({
        id: r.id,
        attempts: r.attempts,
        event: r.event,
        channelId: r.channelId,
        alert: { id: r.alertId, type: r.type, severity: r.severity, affected: r.affected ?? null },
        scheduler: { id: r.schedulerId, displayName: r.displayName },
        envLabel: r.envLabel,
      }));
  }

  private finish(
    rows: DueRow[],
    status: 'sent' | 'failed',
    error: string | null,
    report: TickReport,
  ): void {
    const now = this.clock();
    // 시도 횟수는 줄마다 다를 수 있다
    this.metaDb.db.transaction((tx) => {
      for (const r of rows) {
        tx.update(notifications)
          .set({ status, lastError: error, nextAttemptAt: now, attempts: r.attempts + 1 })
          .where(eq(notifications.id, r.id))
          .run();
      }
    });
    report[status === 'sent' ? 'sent' : 'failed'] += rows.length;
  }

  private retryOrFail(rows: DueRow[], error: string, report: TickReport): void {
    const now = this.clock();
    this.metaDb.db.transaction((tx) => {
      for (const r of rows) {
        const attempts = r.attempts + 1;
        const done = attempts >= MAX_ATTEMPTS;
        tx.update(notifications)
          .set({
            attempts,
            lastError: error,
            status: done ? 'failed' : 'pending',
            nextAttemptAt: done ? now : now + RETRY_BACKOFF_MS[attempts - 1]!,
          })
          .where(eq(notifications.id, r.id))
          .run();
        if (done) report.failed += 1;
        else report.retried += 1;
      }
    });
    if (rows.some((r) => r.attempts + 1 >= MAX_ATTEMPTS)) {
      this.logger.warn(`발송을 끝내 보내지 못했습니다 (채널 ${rows[0]?.channelId}): ${error}`);
    }
  }
}
