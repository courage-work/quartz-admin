import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DEFAULT_ALERT_RULES } from '@qa/shared';
import { eq, notExists } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock.js';
import { SecretBox, secretAad } from '../crypto/secret-box.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import {
  alertRuleChannels,
  alertRules,
  channels,
  schedulers,
  settings,
} from '../meta-db/schema.js';
import type { MonitorTx } from '../monitor/monitor-hooks.js';

/** 기본 규칙을 이미 채웠는지 표시하는 `settings` 키. B-24 이전에 등록한 스케줄러에 한 번만 채운다 */
const BACKFILL_KEY = 'alerts.default_rules_backfilled';
const INAPP_CHANNEL_NAME = '인앱 알림';

/**
 * 기본 규칙 세트와 인앱 채널 (TRD §9.2).
 * 스케줄러를 등록하면 6종 규칙을 기본값으로 만들고 인앱 채널에 연결한다. 인앱 채널은 처음 필요할 때 하나 만든다.
 */
@Injectable()
export class AlertDefaults implements OnApplicationBootstrap {
  private readonly logger = new Logger(AlertDefaults.name);

  constructor(
    private readonly metaDb: MetaDbService,
    private readonly secrets: SecretBox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 인앱 채널을 만들고, B-24 이전에 등록해 규칙이 하나도 없는 스케줄러에 기본 규칙을 채운다(한 번만) */
  onApplicationBootstrap(): void {
    const filled = this.metaDb.db.transaction((tx) => {
      // 인앱 채널은 처음부터 있다. 채널 화면과 규칙 화면이 기본 채널로 보여 준다
      this.inappChannelId(tx);
      if (tx.select().from(settings).where(eq(settings.key, BACKFILL_KEY)).get()) return null;
      const bare = tx
        .select({ id: schedulers.id })
        .from(schedulers)
        .where(
          notExists(
            tx
              .select({ id: alertRules.id })
              .from(alertRules)
              .where(eq(alertRules.schedulerId, schedulers.id)),
          ),
        )
        .all();
      for (const s of bare) this.createDefaultRules(tx, s.id);
      tx.insert(settings).values({ key: BACKFILL_KEY, value: '1', updatedAt: this.clock() }).run();
      return bare.length;
    });
    if (filled) this.logger.log(`기존 스케줄러 ${filled}개에 기본 알림 규칙을 만들었습니다`);
  }

  /** 인앱 채널 id. 없으면 만든다 */
  inappChannelId(tx: MonitorTx): number {
    const existing = tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, 'inapp'))
      .orderBy(channels.id)
      .get();
    if (existing) return existing.id;
    const now = this.clock();
    // 암호문은 행 id에 묶이므로(AAD) 먼저 넣고 채운다
    const row = tx
      .insert(channels)
      .values({
        type: 'inapp',
        name: INAPP_CHANNEL_NAME,
        configEnc: '',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id })
      .get();
    tx.update(channels)
      .set({ configEnc: this.secrets.encrypt('{}', secretAad('channels', row.id)) })
      .where(eq(channels.id, row.id))
      .run();
    return row.id;
  }

  /** 규칙을 인앱 채널에 연결한다 */
  linkInapp(tx: MonitorTx, ruleId: number): void {
    tx.insert(alertRuleChannels)
      .values({ ruleId, channelId: this.inappChannelId(tx) })
      .onConflictDoNothing()
      .run();
  }

  createDefaultRules(tx: MonitorTx, schedulerId: number): void {
    const now = this.clock();
    for (const rule of DEFAULT_ALERT_RULES) {
      const row = tx
        .insert(alertRules)
        .values({
          schedulerId,
          type: rule.type,
          params: rule.params,
          scope: { kind: 'all' },
          severity: rule.severity,
          renotifyMinutes: rule.renotifyMinutes,
          enabled: rule.enabled,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: alertRules.id })
        .get();
      this.linkInapp(tx, row.id);
    }
  }
}
