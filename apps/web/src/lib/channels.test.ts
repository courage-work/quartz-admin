import { channelInputSchema, type ChannelDto } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import {
  channelFormPathOf,
  channelFormValues,
  describeChannelTarget,
  describeFailure,
  describeLastDelivery,
  parseRecipients,
  toChannelRequest,
} from './channels';

const channel = (over: Partial<ChannelDto> = {}): ChannelDto => ({
  id: 2,
  type: 'email',
  name: '운영 메일',
  enabled: true,
  target: 'a@example.com, b@example.com',
  recipients: ['a@example.com', 'b@example.com'],
  ruleCount: 1,
  lastDelivery: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('알림 채널 문구', () => {
  it('보낼 곳과 마지막 발송', () => {
    expect(describeChannelTarget({ type: 'inapp', target: '' })).toBe('알림 센터');
    expect(describeChannelTarget({ type: 'slack', target: 'hooks.slack.com/…/AbCd' })).toBe(
      'hooks.slack.com/…/AbCd',
    );
    expect(describeLastDelivery({ lastDelivery: null })).toBe('보낸 적 없음');
    expect(describeLastDelivery({ lastDelivery: { at: 1, ok: true, error: null } })).toBe('성공');
    expect(
      describeLastDelivery({
        lastDelivery: { at: 1, ok: false, error: 'Slack이 500로 응답했습니다' },
      }),
    ).toBe('실패 · Slack이 500로 응답했습니다');
    expect(describeFailure({ attempts: 4, lastError: null })).toBe('4회 시도 · 원인 모름');
  });
});

describe('채널 폼', () => {
  it('받는 사람은 줄·쉼표·세미콜론으로 나눈다', () => {
    expect(parseRecipients('a@x.co\n b@x.co, c@x.co;\n\n')).toEqual(['a@x.co', 'b@x.co', 'c@x.co']);
  });

  it('저장된 이메일 채널을 폼 값으로 바꾼 뒤 보내면 같은 값이 된다', () => {
    const values = channelFormValues(channel());
    expect(values).toMatchObject({ type: 'email', recipients: 'a@example.com\nb@example.com' });
    expect(channelInputSchema.parse(toChannelRequest(values))).toEqual({
      type: 'email',
      name: '운영 메일',
      enabled: true,
      recipients: ['a@example.com', 'b@example.com'],
    });
  });

  it('Slack 수정에서 웹훅 URL을 비우면 빈 값으로 보내 지금 값을 쓰게 한다', () => {
    const values = channelFormValues(channel({ type: 'slack', recipients: undefined }));
    expect(values.webhookUrl).toBe('');
    expect(channelInputSchema.parse(toChannelRequest(values))).toMatchObject({
      type: 'slack',
      webhookUrl: '',
    });
  });

  it('검증 오류를 입력으로 되돌린다', () => {
    const parsed = channelInputSchema.safeParse(
      toChannelRequest({
        ...channelFormValues(),
        type: 'slack',
        name: '',
        webhookUrl: 'http://x.example',
      }),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.map((i) => channelFormPathOf(i.path)).sort()).toEqual([
      'name',
      'webhookUrl',
    ]);
    const bad = channelInputSchema.safeParse(
      toChannelRequest({ ...channelFormValues(), type: 'email', name: 'x', recipients: 'nope' }),
    );
    expect(bad.error!.issues.map((i) => channelFormPathOf(i.path))).toEqual(['recipients']);
  });
});
