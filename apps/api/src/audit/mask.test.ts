import { describe, expect, it } from 'vitest';
import { isSecretKey, MASK, maskSecrets } from './mask.js';

describe('maskSecrets', () => {
  it('비밀값처럼 보이는 키의 값을 안쪽 객체와 배열까지 가린다', () => {
    const input = {
      username: 'alice',
      password: 'p@ss-1',
      nested: {
        currentPassword: 'old',
        newPassword: 'new',
        apiKey: 'k',
        api_key: 'k',
        clientSecret: 's',
        accessToken: 't',
        passwordEnc: 'v1:k1:abc',
        config_enc: 'v1:k1:def',
        webhookUrl: 'https://hooks.slack.com/services/T/B/X',
      },
      list: [{ password: 'a' }, { name: 'b' }],
    };
    expect(maskSecrets(input)).toEqual({
      username: 'alice',
      password: MASK,
      nested: {
        currentPassword: MASK,
        newPassword: MASK,
        apiKey: MASK,
        api_key: MASK,
        clientSecret: MASK,
        accessToken: MASK,
        passwordEnc: MASK,
        config_enc: MASK,
        webhookUrl: MASK,
      },
      list: [{ password: MASK }, { name: 'b' }],
    });
    // 입력은 바꾸지 않는다
    expect(input.password).toBe('p@ss-1');
  });

  it('비밀 키라도 불리언과 null은 남긴다', () => {
    expect(maskSecrets({ passwordChanged: true, password: null })).toEqual({
      passwordChanged: true,
      password: null,
    });
  });

  it('숫자나 객체로 들어온 비밀값도 가린다', () => {
    expect(maskSecrets({ token: 1234, secret: { a: 1 } })).toEqual({ token: MASK, secret: MASK });
  });

  it('문자열 안의 URL 자격증명을 가린다', () => {
    expect(maskSecrets({ url: 'postgres://app:hunter2@db:5432/q' })).toEqual({
      url: `postgres://app:${MASK}@db:5432/q`,
    });
    expect(maskSecrets('see http://u:p@h/x and http://h/y')).toBe(
      `see http://u:${MASK}@h/x and http://h/y`,
    );
  });

  it('비밀이 아닌 키는 그대로 둔다', () => {
    for (const key of ['username', 'schedName', 'host', 'isActive', 'triggerName', 'description']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it('JSON으로 저장할 수 없는 값은 설명 문자열로 바꾼다', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const shared = { x: 1 };
    expect(
      maskSecrets({
        cyclic,
        at: new Date(Date.UTC(2026, 0, 1)),
        blob: Buffer.from('abc'),
        big: 10n,
        fn: () => 1,
        missing: undefined,
        twice: [shared, shared],
      }),
    ).toEqual({
      cyclic: { a: 1, self: '[circular]' },
      at: '2026-01-01T00:00:00.000Z',
      blob: '[binary]',
      big: '10',
      twice: [{ x: 1 }, { x: 1 }],
    });
  });

  it('너무 깊은 구조는 잘라낸다', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(maskSecrets(deep))).toContain('[truncated]');
  });
});
