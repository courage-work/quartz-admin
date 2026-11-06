import { afterEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../meta-db/maintenance.service.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { tempDataDir } from '../meta-db/test-support.js';
import { LOCKOUT_MS, SESSION_ABSOLUTE_MS } from './policy.js';
import { sessionIdOf } from './sessions.service.js';
import { ADMIN, createTestApp, setCookies, type TestApp } from './test-support.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(options?: Parameters<typeof createTestApp>[0]): Promise<TestApp> {
  t = await createTestApp(options);
  return t;
}

/** 관리자로 일반 사용자를 만들고 그 사용자의 세션 쿠키를 돌려준다 */
async function createUser(app: TestApp, adminCookie: string, username = 'alice') {
  const password = `${username}-password-1`;
  const res = await app.send('post', '/users', { username, password }, adminCookie).expect(201);
  return { id: (res.body as { id: number }).id, username, password };
}

describe('초기 관리자', () => {
  it('users가 비어 있을 때만 만들고, 다시 기동해도 바꾸지 않는다', async () => {
    const tmp = tempDataDir();
    try {
      const first = await createTestApp({ dataDir: tmp.dir });
      await first.login(ADMIN.username, ADMIN.password);
      await first.close();

      // 환경변수의 비밀번호를 바꿔도 기존 계정은 그대로다
      const second = await createTestApp({
        dataDir: tmp.dir,
        config: { admin: { username: 'admin', password: 'changed-password' } },
      });
      t = second;
      await second.send('post', '/auth/login', { ...ADMIN }).expect(200);
      await second
        .send('post', '/auth/login', { username: 'admin', password: 'changed-password' })
        .expect(401);
      const users = second.app.get(MetaDbService).sqlite.prepare('SELECT COUNT(*) n FROM users');
      expect(users.get()).toEqual({ n: 1 });
    } finally {
      await t?.close();
      t = undefined;
      tmp.cleanup();
    }
  });

  it('관리자 환경변수가 없으면 아무도 만들지 않는다', async () => {
    const app = await start({ config: { admin: undefined } });
    const n = app.app.get(MetaDbService).sqlite.prepare('SELECT COUNT(*) n FROM users').get();
    expect(n).toEqual({ n: 0 });
  });
});

describe('로그인과 세션 쿠키', () => {
  it('로그인하면 본인 정보와 HttpOnly·SameSite=Strict 세션 쿠키를 준다', async () => {
    const app = await start();
    const res = await app.send('post', '/auth/login', { ...ADMIN }).expect(200);
    expect(res.body).toEqual({ id: 1, username: 'admin', isAdmin: true });

    const [cookie] = setCookies(res);
    expect(cookie).toMatch(/^qa_sid=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    // 로컬 HTTP 개발 환경(QA_PUBLIC_URL=http://...)에서는 Secure를 끈다
    expect(cookie).not.toContain('Secure');
  });

  it('QA_PUBLIC_URL이 https면 Secure 쿠키를 준다', async () => {
    const app = await start({
      config: {
        publicUrl: 'https://qa.example.com',
        publicOrigin: 'https://qa.example.com',
      },
    });
    const res = await app.send('post', '/auth/login', { ...ADMIN }).expect(200);
    expect(setCookies(res)[0]).toMatch(/; Secure/);
  });

  it('아이디는 대소문자와 앞뒤 공백을 무시한다', async () => {
    const app = await start();
    await app
      .send('post', '/auth/login', { username: ' ADMIN ', password: ADMIN.password })
      .expect(200);
  });

  it('틀린 비밀번호와 없는 아이디는 같은 오류로 응답한다', async () => {
    const app = await start();
    const wrong = await app
      .send('post', '/auth/login', { username: 'admin', password: 'wrong-password' })
      .expect(401);
    const unknown = await app
      .send('post', '/auth/login', { username: 'nobody', password: 'wrong-password' })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: '아이디 또는 비밀번호가 맞지 않습니다',
    });
  });

  it('DB에는 토큰 원문이 아니라 SHA-256만 저장한다', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    const token = cookie.slice('qa_sid='.length);
    const rows = app.app.get(MetaDbService).sqlite.prepare('SELECT id FROM sessions').all();
    expect(rows).toEqual([{ id: sessionIdOf(token) }]);
  });

  it('로그아웃하면 세션이 사라지고 쿠키를 지운다', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    const res = await app.send('post', '/auth/logout', {}, cookie).expect(204);
    expect(setCookies(res)[0]).toMatch(/^qa_sid=;/);
    await app.get('/auth/me', cookie).expect(401);
  });

  it('다시 로그인하면 이전 세션을 버린다', async () => {
    const app = await start();
    const first = await app.login(ADMIN.username, ADMIN.password);
    await app.send('post', '/auth/login', { ...ADMIN }, first).expect(200);
    await app.get('/auth/me', first).expect(401);
  });
});

describe('세션 만료', () => {
  it('30분 동안 요청이 없으면 만료되고, 요청할 때마다 연장된다', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);

    app.clock.advance(29 * 60_000);
    await app.get('/auth/me', cookie).expect(200);
    app.clock.advance(29 * 60_000);
    await app.get('/auth/me', cookie).expect(200);

    app.clock.advance(30 * 60_000);
    const res = await app.get('/auth/me', cookie).expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('계속 쓰더라도 12시간이 지나면 만료된다', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    const step = 20 * 60_000;
    for (let elapsed = step; elapsed < SESSION_ABSOLUTE_MS; elapsed += step) {
      app.clock.advance(step);
      await app.get('/auth/me', cookie).expect(200);
    }
    app.clock.advance(step);
    await app.get('/auth/me', cookie).expect(401);
  });

  it('일일 보존 정리가 만료된 세션 행을 지운다', async () => {
    const app = await start();
    await app.login(ADMIN.username, ADMIN.password);
    app.clock.advance(5 * 60_000);
    await app.login(ADMIN.username, ADMIN.password);

    const report = await app.app
      .get(MaintenanceService)
      // 첫 세션(0분 시작)은 30분에, 두 번째(5분 시작)는 35분에 만료된다
      .runOnce(new Date(app.clock.now + 26 * 60_000));
    expect(report.tasks).toContainEqual({ name: 'sessions', removed: 1 });
    const left = app.app.get(MetaDbService).sqlite.prepare('SELECT COUNT(*) n FROM sessions');
    expect(left.get()).toEqual({ n: 1 });
  });

  it('QA_SESSION_IDLE_MIN으로 유휴 만료 시간을 바꿀 수 있다', async () => {
    const app = await start({ config: { sessionIdleMin: 5 } });
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    app.clock.advance(5 * 60_000);
    await app.get('/auth/me', cookie).expect(401);
  });
});

describe('로그인 실패 잠금과 속도 제한', () => {
  it('5회 연속 실패하면 15분 동안 잠기고, 맞는 비밀번호도 거부한다', async () => {
    const app = await start();
    const wrong = { username: 'admin', password: 'wrong-password' };
    for (let i = 0; i < 4; i++) await app.send('post', '/auth/login', wrong).expect(401);

    const locked = await app.send('post', '/auth/login', wrong).expect(423);
    expect(locked.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect((locked.body as { message: string }).message).toContain('15분 후');
    await app.send('post', '/auth/login', { ...ADMIN }).expect(423);

    app.clock.advance(LOCKOUT_MS);
    await app.send('post', '/auth/login', { ...ADMIN }).expect(200);
  });

  it('성공하면 실패 횟수가 초기화된다', async () => {
    const app = await start();
    const wrong = { username: 'admin', password: 'wrong-password' };
    for (let i = 0; i < 4; i++) await app.send('post', '/auth/login', wrong).expect(401);
    await app.send('post', '/auth/login', { ...ADMIN }).expect(200);
    for (let i = 0; i < 4; i++) await app.send('post', '/auth/login', wrong).expect(401);
    await app.send('post', '/auth/login', { ...ADMIN }).expect(200);
  });

  it('로그인 API는 IP당 분당 10회로 제한하고 Retry-After를 알려준다', async () => {
    const app = await start({ loginRateLimit: 10 });
    const wrong = { username: 'nobody', password: 'wrong-password' };
    for (let i = 0; i < 10; i++) await app.send('post', '/auth/login', wrong).expect(401);

    const limited = await app.send('post', '/auth/login', { ...ADMIN }).expect(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['retry-after']).toBe('60');

    app.clock.advance(60_000);
    await app.send('post', '/auth/login', { ...ADMIN }).expect(200);
  });
});

describe('접근 통제', () => {
  it('인증 없이 보호된 API를 호출하면 401', async () => {
    const app = await start();
    for (const path of ['/auth/me', '/users']) {
      const res = await app.get(path).expect(401);
      expect(res.body).toEqual({ code: 'UNAUTHENTICATED', message: '로그인이 필요합니다' });
    }
    await app.get('/auth/me', 'qa_sid=forged-token').expect(401);
  });

  it('관리자 API를 일반 사용자가 호출하면 403', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const alice = await createUser(app, admin);
    const cookie = await app.login(alice.username, alice.password);

    const res = await app.get('/users', cookie).expect(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    await app
      .send('post', '/users', { username: 'bob', password: 'bob-password-1' }, cookie)
      .expect(403);
    await app.send('patch', `/users/${alice.id}`, { isActive: false }, cookie).expect(403);
    await app.get('/auth/me', cookie).expect(200);
  });
});

describe('CSRF 방어', () => {
  it('Origin이 다르거나 없으면 상태를 바꾸는 요청을 거부한다', async () => {
    const app = await start();
    const login = () => app.send('post', '/auth/login', { ...ADMIN });

    const evil = await login().set('Origin', 'https://evil.example.com').expect(403);
    expect(evil.body).toMatchObject({ code: 'CSRF_REJECTED' });

    const noOrigin = await login().unset('Origin').expect(403);
    expect(noOrigin.body).toMatchObject({ code: 'CSRF_REJECTED' });
  });

  it('X-QA-Request 헤더가 없으면 거부한다', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    const res = await app
      .send('post', '/users', { username: 'bob', password: 'bob-password-1' }, cookie)
      .unset('X-QA-Request')
      .expect(403);
    expect(res.body).toMatchObject({ code: 'CSRF_REJECTED' });
    await app.send('post', '/auth/logout', {}, cookie).set('X-QA-Request', '0').expect(403);
  });

  it('GET은 Origin 검사를 하지 않는다', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    await app.get('/auth/me', cookie).set('Origin', 'https://evil.example.com').expect(200);
  });
});

describe('보안 헤더', () => {
  it('helmet 헤더를 붙이고 X-Powered-By를 뺀다', async () => {
    const app = await start();
    const res = await app.get('/auth/me');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('사용자 관리 (관리자)', () => {
  it('사용자를 추가하고 목록에 비밀번호 해시 없이 보여준다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const created = await app
      .send(
        'post',
        '/users',
        { username: 'Bob', password: 'bob-password-1', isAdmin: false },
        admin,
      )
      .expect(201);
    expect(created.body).toMatchObject({ username: 'bob', isAdmin: false, isActive: true });

    const list = await app.get('/users', admin).expect(200);
    expect((list.body as { username: string }[]).map((u) => u.username)).toEqual(['admin', 'bob']);
    expect(JSON.stringify(list.body)).not.toMatch(/password/i);
  });

  it('중복 아이디는 409, 형식 오류는 400이며 입력한 비밀번호를 돌려주지 않는다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const dup = await app
      .send('post', '/users', { username: 'ADMIN', password: 'some-password-1' }, admin)
      .expect(409);
    expect(dup.body).toMatchObject({ code: 'USERNAME_TAKEN' });

    const invalid = await app
      .send('post', '/users', { username: 'x', password: 'short7!' }, admin)
      .expect(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [
        { path: 'username', message: expect.stringContaining('3~64자') as string },
        { path: 'password', message: '비밀번호는 8자 이상이어야 합니다' },
      ],
    });
    expect(JSON.stringify(invalid.body)).not.toContain('short7!');
  });

  it('비활성화하면 그 사용자의 세션이 끊기고 로그인할 수 없다. 다시 활성화할 수 있다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const alice = await createUser(app, admin);
    const aliceCookie = await app.login(alice.username, alice.password);

    const res = await app
      .send('patch', `/users/${alice.id}`, { isActive: false }, admin)
      .expect(200);
    expect(res.body).toMatchObject({ id: alice.id, isActive: false });
    await app.get('/auth/me', aliceCookie).expect(401);
    await app
      .send('post', '/auth/login', { username: alice.username, password: alice.password })
      .expect(401);

    await app.send('patch', `/users/${alice.id}`, { isActive: true }, admin).expect(200);
    await app.login(alice.username, alice.password);
  });

  it('본인 계정은 비활성화할 수 없고, 다른 관리자는 비활성화할 수 있다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const self = await app.send('patch', '/users/1', { isActive: false }, admin).expect(409);
    expect(self.body).toMatchObject({
      code: 'OPERATION_NOT_ALLOWED',
      message: '본인 계정은 비활성화할 수 없습니다',
    });

    await app
      .send(
        'post',
        '/users',
        { username: 'root2', password: 'root2-password', isAdmin: true },
        admin,
      )
      .expect(201);
    const second = await app.login('root2', 'root2-password');
    await app.send('patch', '/users/1', { isActive: false }, second).expect(200);
    await app.get('/auth/me', admin).expect(401);
  });

  it('비밀번호를 초기화하면 기존 세션이 끊기고 잠금이 풀린다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const alice = await createUser(app, admin);
    const aliceCookie = await app.login(alice.username, alice.password);
    for (let i = 0; i < 5; i++) {
      await app.send('post', '/auth/login', { username: alice.username, password: 'nope-nope' });
    }
    const locked = await app.get('/users', admin).expect(200);
    expect(
      (locked.body as { id: number; lockedUntil: number | null }[]).find((u) => u.id === alice.id),
    ).toMatchObject({ lockedUntil: app.clock.now + LOCKOUT_MS });

    await app
      .send('post', `/users/${alice.id}/reset-password`, { password: 'reset-password-1' }, admin)
      .expect(204);
    await app.get('/auth/me', aliceCookie).expect(401);
    await app.login(alice.username, 'reset-password-1');
  });

  it('없는 사용자는 404, 숫자가 아닌 ID는 400', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const missing = await app.send('patch', '/users/999', { isActive: false }, admin).expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
    const bad = await app.send('patch', '/users/abc', { isActive: false }, admin).expect(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('본인 비밀번호 변경', () => {
  it('현재 비밀번호가 틀리면 400 WRONG_PASSWORD', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    const res = await app
      .send(
        'put',
        '/auth/password',
        { currentPassword: 'nope', newPassword: 'new-password-1' },
        cookie,
      )
      .expect(400);
    expect(res.body).toMatchObject({ code: 'WRONG_PASSWORD' });
  });

  it('바꾸면 현재 세션은 유지하고 다른 세션은 끊는다', async () => {
    const app = await start();
    const current = await app.login(ADMIN.username, ADMIN.password);
    const other = await app.login(ADMIN.username, ADMIN.password);
    await app
      .send(
        'put',
        '/auth/password',
        { currentPassword: ADMIN.password, newPassword: 'new-password-1' },
        current,
      )
      .expect(204);
    await app.get('/auth/me', current).expect(200);
    await app.get('/auth/me', other).expect(401);
    await app.send('post', '/auth/login', { ...ADMIN }).expect(401);
    await app.login(ADMIN.username, 'new-password-1');
  });
});

describe('오류 응답 형식', () => {
  it('없는 경로와 깨진 JSON도 ApiErrorBody로 응답한다', async () => {
    const app = await start();
    const missing = await app.get('/nope').expect(404);
    expect(missing.body).toEqual({ code: 'NOT_FOUND', message: '요청한 경로를 찾을 수 없습니다' });

    const broken = await app
      .send('post', '/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"username":')
      .expect(400);
    expect(broken.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
