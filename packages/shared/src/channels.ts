/**
 * 알림 채널 (TRD §9.4, PRD FR-ALT-07)
 *
 * 인앱 채널은 하나뿐이고 도구가 만든다(바꾸거나 지울 수 없음). Slack(Incoming Webhook)과 이메일(SMTP) 채널은
 * 사용자가 만든다. 웹훅 URL과 수신자는 비밀값처럼 암호화해 저장하고, 화면에는 웹훅 URL을 가려서 보여 준다.
 */
import { z } from 'zod';
import type { ChannelType } from './domain.js';

export const CHANNEL_NAME_MAX = 100;
export const EMAIL_RECIPIENTS_MAX = 20;
const WEBHOOK_URL_MAX = 2_000;

/** 개발·테스트에서 가짜 서버를 쓰도록 http를 허용하는 호스트 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** 웹훅 URL은 https만 받는다. 로컬 개발·테스트용으로 localhost만 http를 허용한다 */
export function isAllowedWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

const name = z
  .string({ error: '이름을 입력하세요' })
  .trim()
  .min(1, { error: '이름을 입력하세요' })
  .max(CHANNEL_NAME_MAX, { error: `이름은 ${CHANNEL_NAME_MAX}자까지 입력할 수 있습니다` });

/** 수정에서 비우면 지금 값을 그대로 쓴다. 추가에서는 서버가 필수로 검사한다 */
const webhookUrl = z
  .string()
  .trim()
  .max(WEBHOOK_URL_MAX, { error: '웹훅 URL이 너무 깁니다' })
  .refine((v) => v === '' || isAllowedWebhookUrl(v), {
    error: '웹훅 URL은 https://로 시작해야 합니다',
  });

const recipients = z
  .array(z.email({ error: '이메일 주소 형식이 아닙니다' }))
  .min(1, { error: '받는 사람을 한 명 이상 입력하세요' })
  .max(EMAIL_RECIPIENTS_MAX, {
    error: `받는 사람은 ${EMAIL_RECIPIENTS_MAX}명까지 입력할 수 있습니다`,
  });

/** `POST /channels`, `PUT /channels/:id`. 인앱 채널은 만들거나 바꿀 수 없다 */
export const channelInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('slack'),
    name,
    enabled: z.boolean(),
    webhookUrl: webhookUrl.optional(),
  }),
  z.object({
    type: z.literal('email'),
    name,
    enabled: z.boolean(),
    recipients,
  }),
]);
export type ChannelInput = z.infer<typeof channelInputSchema>;

export interface ChannelDto {
  id: number;
  type: ChannelType;
  name: string;
  enabled: boolean;
  /** 보낼 곳 요약. Slack은 가린 웹훅 URL(`hooks.slack.com/…/AbCd`), 이메일은 받는 사람, 인앱은 빈 문자열 */
  target: string;
  /** 이메일 채널의 받는 사람(수정 화면용) */
  recipients?: string[];
  /** 연결된 규칙 수 */
  ruleCount: number;
  /** 마지막 발송 결과 */
  lastDelivery: { at: number; ok: boolean; error: string | null } | null;
  createdAt: number;
  updatedAt: number;
}

/** `GET /channels` */
export interface ChannelsResponse {
  channels: ChannelDto[];
  /** `QA_SMTP_*`를 설정했는지. 아니면 이메일 채널은 보낼 수 없다 */
  smtpConfigured: boolean;
}

/** `POST /channels/:id/test`. 실패도 200으로 돌려준다(연결 테스트와 같음) */
export interface ChannelTestResult {
  ok: boolean;
  message: string;
  durationMs: number;
}
