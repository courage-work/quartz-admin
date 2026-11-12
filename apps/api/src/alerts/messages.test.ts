import { describe, expect, it } from 'vitest';
import { emailContent, slackPayload, type OutboundItem } from './messages.js';

/** 표시 이름은 등록할 때 대상 DB의 SCHED_NAME에서 기본값을 가져오므로 신뢰하지 않는다 (B-32) */
const hostile = '<!channel> <https://evil.example|여기> <script>alert(1)</script> & co';

const item = (displayName: string): OutboundItem => ({
  event: 'fire',
  alert: { id: 1, type: 'TRIGGER_ERROR', severity: 'critical', affected: null },
  scheduler: { id: 7, displayName },
  envLabel: 'prod',
});

describe('알림 메시지의 이스케이프', () => {
  it('Slack 메시지는 알림 미리보기 text까지 mrkdwn 제어 문자를 바꾼다', () => {
    for (const items of [[item(hostile)], [item(hostile), item(hostile)]]) {
      const json = JSON.stringify(slackPayload(items, 'https://qa.example.com'));
      expect(json).not.toContain('<!channel>');
      expect(json).not.toContain('<https://evil.example');
      expect(json).not.toContain('<script>');
      expect(json).toContain('&lt;!channel&gt;');
    }
  });

  it('이메일 HTML은 태그를 이스케이프한다', () => {
    const { html } = emailContent([item(hostile)], 'https://qa.example.com');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
