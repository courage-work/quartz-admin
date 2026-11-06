import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './password-hasher.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import { readSessionToken, sessionCookieOptions } from './session-cookie.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('argon2id(m=19456, t=2, p=1)로 해시하고 검증한다', async () => {
    const hash = await hasher.hash('correct horse');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(hash, 'correct horse')).toBe(true);
    expect(await hasher.verify(hash, 'wrong horse')).toBe(false);
  });

  it('같은 비밀번호도 매번 다른 솔트로 해시한다', async () => {
    expect(await hasher.hash('pw-pw-pw-pw')).not.toBe(await hasher.hash('pw-pw-pw-pw'));
  });

  it('깨진 해시는 예외 대신 false', async () => {
    expect(await hasher.verify('not-a-hash', 'pw')).toBe(false);
    expect(await hasher.verifyDummy('pw')).toBe(false);
  });
});

describe('FixedWindowRateLimiter', () => {
  it('창 안에서 limit까지 허용하고, 넘으면 남은 초를 돌려준다', () => {
    const limiter = new FixedWindowRateLimiter(3, 60_000);
    expect([0, 1, 2].map(() => limiter.hit('a', 0))).toEqual([null, null, null]);
    expect(limiter.hit('a', 15_000)).toBe(45);
    expect(limiter.hit('b', 15_000)).toBeNull();
    expect(limiter.hit('a', 60_000)).toBeNull();
  });

  it('키가 많아지면 지난 창을 정리한다', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000, 3);
    for (const key of ['a', 'b', 'c']) limiter.hit(key, 0);
    limiter.hit('d', 5_000);
    expect(limiter.size).toBe(1);
  });
});

describe('세션 쿠키', () => {
  it('qa_sid만 읽고, 형식이 이상한 값은 버린다', () => {
    const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });
    expect(readSessionToken(req('a=1; qa_sid=abc_DEF-123; b=2'))).toBe('abc_DEF-123');
    expect(readSessionToken(req('qa_sid_old=x'))).toBeUndefined();
    expect(readSessionToken(req('qa_sid=a%20b'))).toBeUndefined();
    expect(readSessionToken(req())).toBeUndefined();
  });

  it('https 공개 URL에서만 Secure를 켠다', () => {
    expect(sessionCookieOptions({ publicUrl: 'https://qa.example.com' })).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
    expect(sessionCookieOptions({ publicUrl: 'http://localhost:3000' }).secure).toBe(false);
  });
});
