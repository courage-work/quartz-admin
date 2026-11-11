import { Inject, Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import type { EmailContent } from './messages.js';

/** 발송 실패. 메시지는 발송 큐(`last_error`)와 화면에 그대로 보이므로 웹훅 URL 같은 비밀값을 넣지 않는다 */
export class SendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendError';
  }
}

/** 한 번 보낼 때 기다리는 시간. 넘으면 실패로 보고 다음 시도로 미룬다 (TRD §9.4) */
export const SEND_TIMEOUT_MS = 10_000;

function causeCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'UNKNOWN';
}

/** Slack Incoming Webhook과 SMTP로 보낸다. 실패는 모두 {@link SendError}로 바꾼다 */
@Injectable()
export class Senders {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get smtpConfigured(): boolean {
    return this.config.smtp !== undefined;
  }

  async slack(webhookUrl: string, payload: unknown, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new SendError(`Slack이 ${timeoutMs / 1_000}초 안에 응답하지 않았습니다`);
      }
      throw new SendError(`Slack에 연결하지 못했습니다 (${causeCode(err)})`);
    }
    if (!res.ok) {
      // 응답 본문은 짧은 오류 코드(invalid_token 등)다. 길면 자른다
      const body = (await res.text().catch(() => '')).slice(0, 100).trim();
      throw new SendError(`Slack이 ${res.status}로 응답했습니다${body ? `: ${body}` : ''}`);
    }
    await res.body?.cancel().catch(() => undefined);
  }

  async email(
    recipients: string[],
    content: EmailContent,
    timeoutMs = SEND_TIMEOUT_MS,
  ): Promise<void> {
    const smtp = this.config.smtp;
    if (!smtp) {
      throw new SendError('SMTP를 설정하지 않았습니다(QA_SMTP_HOST, QA_SMTP_FROM)');
    }
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {}),
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    try {
      await transport.sendMail({
        from: smtp.from,
        to: recipients,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
    } catch (err) {
      const code = causeCode(err);
      const response = (err as { response?: unknown }).response;
      throw new SendError(
        typeof response === 'string'
          ? `SMTP 서버가 거부했습니다: ${response.slice(0, 100)}`
          : `SMTP 서버로 보내지 못했습니다 (${code})`,
      );
    } finally {
      transport.close();
    }
  }
}
