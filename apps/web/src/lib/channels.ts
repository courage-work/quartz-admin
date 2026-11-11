import type { ChannelDto, ChannelType, DeliveryFailureDto, NotificationEvent } from '@qa/shared';

export const CHANNELS_KEY = ['channels'] as const;
export const ALERT_SUMMARY_KEY = ['alerts', 'summary'] as const;
export const alertCenterKey = (status: string, page: number) =>
  ['alerts', 'center', status, page] as const;
export const DELIVERY_FAILURES_KEY = ['alerts', 'delivery-failures'] as const;

/** 읽지 않은 수를 다시 읽는 주기 (TRD §9.4) */
export const ALERT_SUMMARY_REFRESH_MS = 30_000;

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  inapp: '인앱',
  slack: 'Slack',
  email: '이메일',
};

export const EVENT_LABELS: Record<NotificationEvent, string> = {
  fire: '발생',
  update: '대상 늘어남',
  reminder: '계속됨',
  resolve: '해소',
};

/** 채널 표의 "보낼 곳" 칸 */
export function describeChannelTarget(channel: Pick<ChannelDto, 'type' | 'target'>): string {
  if (channel.type === 'inapp') return '알림 센터';
  return channel.target || '-';
}

/** 채널 이름 옆의 짧은 설명 */
export function describeLastDelivery(channel: Pick<ChannelDto, 'lastDelivery'>): string {
  const last = channel.lastDelivery;
  if (!last) return '보낸 적 없음';
  return last.ok ? '성공' : `실패 · ${last.error ?? '원인 모름'}`;
}

export function describeFailure(f: Pick<DeliveryFailureDto, 'attempts' | 'lastError'>): string {
  return `${f.attempts}회 시도 · ${f.lastError ?? '원인 모름'}`;
}

// ── 채널 폼 ──────────────────────────────────────────────────────

export interface ChannelFormValues {
  type: 'slack' | 'email';
  name: string;
  /** 수정에서 비우면 지금 값을 그대로 쓴다 */
  webhookUrl: string;
  /** 줄마다(또는 쉼표로) 이메일 주소 하나 */
  recipients: string;
  enabled: boolean;
}

export function channelFormValues(channel?: ChannelDto): ChannelFormValues {
  return {
    type: channel?.type === 'email' ? 'email' : 'slack',
    name: channel?.name ?? '',
    webhookUrl: '',
    recipients: (channel?.recipients ?? []).join('\n'),
    enabled: channel?.enabled ?? true,
  };
}

export function parseRecipients(text: string): string[] {
  return text
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 화면 값 → 요청 본문 */
export function toChannelRequest(v: ChannelFormValues): unknown {
  return v.type === 'slack'
    ? { type: 'slack', name: v.name, enabled: v.enabled, webhookUrl: v.webhookUrl.trim() }
    : {
        type: 'email',
        name: v.name,
        enabled: v.enabled,
        recipients: parseRecipients(v.recipients),
      };
}

/** 요청 본문의 오류 경로 → 폼 입력 */
export function channelFormPathOf(path: readonly PropertyKey[]): keyof ChannelFormValues | null {
  const head = String(path[0] ?? '');
  if (head === 'recipients') return 'recipients';
  if (head === 'webhookUrl' || head === 'name' || head === 'type' || head === 'enabled')
    return head;
  return null;
}
