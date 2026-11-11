import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ChannelDto, ChannelInput, ChannelTestResult } from '@qa/shared';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { ApiError, notFound } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { SecretBox, secretAad } from '../crypto/secret-box.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { alertRuleChannels, channels, notifications } from '../meta-db/schema.js';
import { emailContent, slackPayload, type OutboundItem } from './messages.js';
import { SendError, Senders } from './senders.js';

type ChannelRow = typeof channels.$inferSelect;

/** 복호화한 채널 설정 */
export type ChannelConfig = { webhookUrl?: string; recipients?: string[] };

export interface ResolvedChannel {
  row: ChannelRow;
  config: ChannelConfig;
}

/** 화면에 보여 줄 웹훅 URL: 호스트와 끝 네 글자만 (`hooks.slack.com/…/AbCd`) */
export function maskWebhook(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '').slice(-4);
    return `${u.host}/…${tail ? `/${tail}` : ''}`;
  } catch {
    return '…';
  }
}

/** 감사 기록에 남기는 채널 값. 웹훅 URL은 가린 값만 */
export function channelView(row: ChannelRow, config: ChannelConfig) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    ...(row.type === 'slack' ? { target: maskWebhook(config.webhookUrl) } : {}),
    ...(row.type === 'email' ? { recipients: config.recipients ?? [] } : {}),
  };
}

const notAllowed = (message: string) =>
  new ApiError(HttpStatus.CONFLICT, 'OPERATION_NOT_ALLOWED', message);

/** 알림 채널 관리와 테스트 발송 (FR-ALT-07, TRD §9.4) */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly metaDb: MetaDbService,
    private readonly secrets: SecretBox,
    private readonly senders: Senders,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  get smtpConfigured(): boolean {
    return this.senders.smtpConfigured;
  }

  decrypt(row: ChannelRow): ChannelConfig {
    if (!row.configEnc) return {};
    return JSON.parse(
      this.secrets.decrypt(row.configEnc, secretAad('channels', row.id)),
    ) as ChannelConfig;
  }

  find(id: number): ResolvedChannel | undefined {
    const row = this.metaDb.db.select().from(channels).where(eq(channels.id, id)).get();
    return row ? { row, config: this.decrypt(row) } : undefined;
  }

  require(id: number): ResolvedChannel {
    const found = this.find(id);
    if (!found) throw notFound('알림 채널을 찾을 수 없습니다');
    return found;
  }

  /** 인앱 채널을 먼저, 나머지는 이름순 */
  list(): ChannelDto[] {
    const rows = this.metaDb.db.select().from(channels).all();
    const ruleCounts = new Map(
      this.metaDb.db
        .select({ id: alertRuleChannels.channelId, n: count() })
        .from(alertRuleChannels)
        .groupBy(alertRuleChannels.channelId)
        .all()
        .map((r) => [r.id, r.n]),
    );
    return rows
      .sort((a, b) =>
        a.type === 'inapp' ? -1 : b.type === 'inapp' ? 1 : a.name.localeCompare(b.name, 'ko'),
      )
      .map((row) => this.toDto(row, ruleCounts.get(row.id) ?? 0));
  }

  get(id: number): ChannelDto {
    const { row } = this.require(id);
    const rules = this.metaDb.db
      .select({ n: count() })
      .from(alertRuleChannels)
      .where(eq(alertRuleChannels.channelId, id))
      .get();
    return this.toDto(row, rules?.n ?? 0);
  }

  create(input: ChannelInput): ChannelDto {
    const config = this.configOf(input, undefined);
    const now = this.clock();
    const id = this.metaDb.db.transaction((tx) => {
      // 암호문은 행 id에 묶이므로(AAD) 먼저 넣고 채운다
      const row = tx
        .insert(channels)
        .values({
          type: input.type,
          name: input.name,
          enabled: input.enabled,
          configEnc: '',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: channels.id })
        .get();
      tx.update(channels)
        .set({ configEnc: this.encrypt(config, row.id) })
        .where(eq(channels.id, row.id))
        .run();
      return row.id;
    });
    return this.get(id);
  }

  /** 종류는 바꿀 수 없다. 끄면 아직 보내지 않은 발송을 버린다 */
  update(id: number, input: ChannelInput): ChannelDto {
    const current = this.require(id);
    if (current.row.type === 'inapp') throw notAllowed('인앱 채널은 바꿀 수 없습니다');
    if (current.row.type !== input.type) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        '채널 종류는 바꿀 수 없습니다',
        [{ path: 'type', message: '채널 종류는 바꿀 수 없습니다' }],
      );
    }
    const config = this.configOf(input, current.config);
    this.metaDb.db.transaction((tx) => {
      tx.update(channels)
        .set({
          name: input.name,
          enabled: input.enabled,
          configEnc: this.encrypt(config, id),
          updatedAt: this.clock(),
        })
        .where(eq(channels.id, id))
        .run();
      if (!input.enabled) {
        tx.delete(notifications)
          .where(and(eq(notifications.channelId, id), eq(notifications.status, 'pending')))
          .run();
      }
    });
    return this.get(id);
  }

  /** 연결된 규칙에서도 빠진다(외래키 cascade). 발송 기록도 함께 지워진다 */
  delete(id: number): ResolvedChannel {
    const current = this.require(id);
    if (current.row.type === 'inapp') throw notAllowed('인앱 채널은 지울 수 없습니다');
    this.metaDb.db.delete(channels).where(eq(channels.id, id)).run();
    return current;
  }

  /** 예시 알림 하나를 바로 보낸다. 발송 큐를 거치지 않는다 */
  async test(id: number): Promise<ChannelTestResult> {
    const { row, config } = this.require(id);
    const started = this.clock();
    const item: OutboundItem = {
      event: 'fire',
      alert: {
        id: 0,
        type: 'TRIGGER_ERROR',
        severity: 'info',
        affected: {
          kind: 'triggers',
          total: 1,
          triggers: [{ group: 'quartz-admin', name: 'test' }],
        },
      },
      scheduler: { id: 0, displayName: '테스트 발송' },
      envLabel: null,
    };
    try {
      if (row.type === 'inapp') {
        return {
          ok: true,
          message: '인앱 알림은 따로 보낼 것이 없습니다. 알림 센터에서 봅니다',
          durationMs: 0,
        };
      }
      if (row.type === 'slack') {
        await this.senders.slack(
          config.webhookUrl ?? '',
          slackPayload([item], this.config.publicUrl),
        );
      } else {
        await this.senders.email(
          config.recipients ?? [],
          emailContent([item], this.config.publicUrl),
        );
      }
      return {
        ok: true,
        message: `${row.name}(으)로 보냈습니다`,
        durationMs: this.clock() - started,
      };
    } catch (err) {
      if (!(err instanceof SendError)) throw err;
      return { ok: false, message: err.message, durationMs: this.clock() - started };
    }
  }

  /** 규칙에 연결할 채널 id가 모두 있는지 */
  assertExist(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const found = this.metaDb.db
      .select({ id: channels.id })
      .from(channels)
      .where(inArray(channels.id, [...ids]))
      .all();
    if (found.length !== new Set(ids).size) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', '없는 채널이 있습니다', [
        { path: 'channelIds', message: '없는 채널이 있습니다' },
      ]);
    }
  }

  private configOf(input: ChannelInput, current: ChannelConfig | undefined): ChannelConfig {
    if (input.type === 'email') return { recipients: input.recipients };
    const webhookUrl = input.webhookUrl || current?.webhookUrl;
    if (!webhookUrl) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', '웹훅 URL을 입력하세요', [
        { path: 'webhookUrl', message: '웹훅 URL을 입력하세요' },
      ]);
    }
    return { webhookUrl };
  }

  private encrypt(config: ChannelConfig, id: number): string {
    return this.secrets.encrypt(JSON.stringify(config), secretAad('channels', id));
  }

  private toDto(row: ChannelRow, ruleCount: number): ChannelDto {
    const config = this.decrypt(row);
    const last = this.metaDb.db
      .select({
        status: notifications.status,
        error: notifications.lastError,
        at: notifications.nextAttemptAt,
      })
      .from(notifications)
      .where(and(eq(notifications.channelId, row.id), ne(notifications.status, 'pending')))
      .orderBy(desc(notifications.id))
      .limit(1)
      .get();
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled,
      target:
        row.type === 'slack'
          ? maskWebhook(config.webhookUrl)
          : row.type === 'email'
            ? (config.recipients ?? []).join(', ')
            : '',
      ...(row.type === 'email' ? { recipients: config.recipients ?? [] } : {}),
      ruleCount,
      lastDelivery: last
        ? {
            at: last.at,
            ok: last.status === 'sent',
            error: last.status === 'sent' ? null : last.error,
          }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
