import { randomBytes } from 'node:crypto';
import { CSRF_HEADER } from '@qa/shared';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, testLogs, type TestApp } from './auth/test-support.js';

/**
 * 보안 점검 (B-32, TRD §4.5). 라우트 하나하나가 아니라 등록된 라우트 전체에 인증·권한·CSRF 규칙이 걸리는지,
 * 비밀값이 응답과 로그 어디에도 나오지 않는지 확인한다. 새 라우트를 추가하면 이 테스트가 함께 확인한다.
 */

/** 로그인 없이 부를 수 있는 라우트. 여기에 없는 라우트는 모두 401이어야 한다 */
const PUBLIC_ROUTES = new Set([
  'GET /healthz',
  'GET /readyz',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
]);

/** 관리자 전용 라우트(PRD FR-USR-03: 사용자 관리만) */
const isAdminRoute = (path: string) => path.startsWith('/api/v1/users');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

interface Route {
  method: string;
  path: string;
}

/** Express 5 라우터에 등록된 라우트 목록 */
function listRoutes(t: TestApp): Route[] {
  const express = t.app.getHttpAdapter().getInstance() as Express & {
    router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  };
  const routes: Route[] = [];
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods).filter((m) => HTTP_METHODS.has(m));
    // 모든 메서드로 등록된 경로(`/api/v1{/*splat}` 없는 경로 처리, 헬스체크 접두사 제외)는 컨트롤러 라우트가 아니다
    if (methods.length >= HTTP_METHODS.size) continue;
    for (const method of methods)
      routes.push({ method: method.toUpperCase(), path: layer.route.path });
  }
  return routes;
}

/** `:id` 같은 경로 파라미터를 숫자로 채운다 */
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, '1');

function call(t: TestApp, route: Route, opts: { cookie?: string; csrf?: boolean } = {}) {
  const server = t.app.getHttpServer();
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let req = request(server)[method](concrete(route.path));
  if (opts.csrf !== false) req = req.set('Origin', t.config.publicOrigin).set(CSRF_HEADER, '1');
  if (opts.cookie) req = req.set('Cookie', opts.cookie);
  return req;
}

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('라우트 전체의 접근 통제', () => {
  it('공개 라우트 목록 밖의 모든 라우트는 로그인 없이 401이다', async () => {
    t = await createTestApp();
    const routes = listRoutes(t);
    expect(routes.length).toBeGreaterThan(50);
    const exposed: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key)) continue;
      const res = await call(t, route);
      if (res.status !== 401) exposed.push(`${key} → ${res.status}`);
    }
    expect(exposed).toEqual([]);
    // 공개 목록이 실제 라우트와 어긋나지 않게
    const actual = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect([...PUBLIC_ROUTES].filter((r) => !actual.has(r))).toEqual([]);
  });

  it('위조하거나 끝난 세션 쿠키는 로그인하지 않은 것과 같다', async () => {
    t = await createTestApp();
    const forged = `qa_sid=${randomBytes(32).toString('base64url')}`;
    await t.get('/auth/me', forged).expect(401);
    await t.get('/auth/me', 'qa_sid=').expect(401);
    await t.get('/auth/me', `qa_sid=${'A'.repeat(5_000)}`).expect(401);
    const cookie = await t.login(ADMIN.username, ADMIN.password);
    await t.send('post', '/auth/logout', undefined, cookie).expect(204);
    await t.get('/auth/me', cookie).expect(401);
  });

  it('관리자 전용 라우트는 일반 사용자에게 모두 403이고, 그 밖의 라우트는 403을 주지 않는다', async () => {
    t = await createTestApp();
    const admin = await t.login(ADMIN.username, ADMIN.password);
    await t
      .send(
        'post',
        '/users',
        { username: 'operator', password: 'operator-pass-1', isAdmin: false },
        admin,
      )
      .expect(201);
    const user = await t.login('operator', 'operator-pass-1');
    const wrong: string[] = [];
    for (const route of listRoutes(t)) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key) || route.path.includes('/auth/')) continue;
      const res = await call(t, route, { cookie: user });
      const forbidden = res.status === 403 && (res.body as { code?: string }).code === 'FORBIDDEN';
      if (isAdminRoute(route.path) !== forbidden) wrong.push(`${key} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('상태를 바꾸는 모든 라우트는 CSRF 헤더가 없으면 인증보다 먼저 거부한다', async () => {
    t = await createTestApp();
    const cookie = await t.login(ADMIN.username, ADMIN.password);
    const accepted: string[] = [];
    for (const route of listRoutes(t)) {
      if (route.method === 'GET' || route.method === 'HEAD') continue;
      for (const cookieOrNot of [cookie, undefined]) {
        const res = await call(t, route, { csrf: false, ...(cookieOrNot ? { cookie } : {}) });
        if (res.status !== 403 || (res.body as { code?: string }).code !== 'CSRF_REJECTED') {
          accepted.push(
            `${route.method} ${route.path}${cookieOrNot ? '' : ' (쿠키 없음)'} → ${res.status}`,
          );
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  it('X-Forwarded-For를 바꿔도 로그인 속도 제한을 피할 수 없다(프록시를 신뢰하지 않는 기본값)', async () => {
    t = await createTestApp({ loginRateLimit: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await t
        .send('post', '/auth/login', { username: 'nobody', password: 'wrong-password' })
        .set('X-Forwarded-For', `203.0.113.${i + 1}`);
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  it('큰 요청 본문은 413으로 거부한다', async () => {
    t = await createTestApp();
    const cookie = await t.login(ADMIN.username, ADMIN.password);
    const res = await t.send('post', '/connections', { name: 'x'.repeat(2_000_000) }, cookie);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('보안 헤더', () => {
  it('API 응답은 성공·오류 모두 보안 헤더를 갖추고 캐시에 남지 않는다', async () => {
    t = await createTestApp();
    const cookie = await t.login(ADMIN.username, ADMIN.password);
    const responses = [
      await t.get('/auth/me', cookie).expect(200),
      await t.get('/auth/me').expect(401),
      await t.get('/no-such-route', cookie).expect(404),
      await request(t.app.getHttpServer()).post('/api/v1/users').send({}).expect(403),
    ];
    for (const res of responses) {
      const h = res.headers;
      expect(h['cache-control']).toBe('no-store');
      expect(h['content-security-policy']).toContain("default-src 'self'");
      expect(h['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(h['content-security-policy']).toContain("object-src 'none'");
      expect(h['x-frame-options']).toBe('SAMEORIGIN');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['cross-origin-opener-policy']).toBe('same-origin');
      expect(h['x-powered-by']).toBeUndefined();
      // 다른 오리진에서 API를 부를 수 없다(CORS를 열지 않음)
      expect(h['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('비밀값 노출 (NFR-SEC-03)', () => {
  it('접속·채널·사용자 비밀번호는 응답, 감사 로그, 서버 로그 어디에도 나오지 않는다', async () => {
    t = await createTestApp();
    const cookie = await t.login(ADMIN.username, ADMIN.password);
    const secrets = {
      connection: 'Conn-Secret-7781!',
      changed: 'Conn-Secret-Changed-7782!',
      tested: 'Conn-Secret-Tested-7783!',
      webhook: 'SLACKTOKEN7784abcdef',
      user: 'user-secret-pass-7785',
      userReset: 'user-secret-reset-7786',
    };
    const target = {
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: 1,
      database: 'quartz',
      username: 'quartz_app',
      envLabel: 'dev',
    };
    const responses: string[] = [];
    const keep = (res: request.Response) => {
      responses.push(res.text);
      return res;
    };

    // 연결 테스트(닫힌 포트), 접속 추가·수정, 채널 추가·수정, 사용자 추가·비밀번호 초기화
    keep(
      await t.send('post', '/connections/test', { ...target, password: secrets.tested }, cookie),
    );
    const conn = keep(
      await t
        .send(
          'post',
          '/connections',
          { ...target, name: 'sec', password: secrets.connection },
          cookie,
        )
        .expect(201),
    ).body as { id: number };
    keep(
      await t
        .send(
          'put',
          `/connections/${conn.id}`,
          { ...target, name: 'sec', password: secrets.changed },
          cookie,
        )
        .expect(200),
    );
    keep(await t.send('post', `/connections/${conn.id}/detect`, {}, cookie));
    const channel = keep(
      await t
        .send(
          'post',
          '/channels',
          {
            type: 'slack',
            name: 'sec',
            enabled: true,
            webhookUrl: `https://127.0.0.1:1/services/T000/B000/${secrets.webhook}`,
          },
          cookie,
        )
        .expect(201),
    ).body as { id: number };
    keep(await t.send('post', `/channels/${channel.id}/test`, {}, cookie));
    const user = keep(
      await t
        .send(
          'post',
          '/users',
          { username: 'sec-user', password: secrets.user, isAdmin: false },
          cookie,
        )
        .expect(201),
    ).body as { id: number };
    keep(
      await t
        .send('post', `/users/${user.id}/reset-password`, { password: secrets.userReset }, cookie)
        .expect((res) => expect(res.status).toBeLessThan(300)),
    );

    // 조회 화면이 읽는 API
    for (const path of [
      '/connections',
      `/connections/${conn.id}`,
      '/channels',
      `/channels/${channel.id}`,
      '/users',
      '/audit-logs',
      '/schedulers',
      '/auth/me',
    ]) {
      keep(await t.get(path, cookie).expect(200));
    }

    const everything = [...responses, ...testLogs.lines.map((l) => JSON.stringify(l))].join('\n');
    for (const secret of Object.values(secrets)) expect(everything).not.toContain(secret);
    // 비밀번호 해시와 저장된 암호문도 내보내지 않는다
    expect(everything).not.toMatch(/\$argon2id\$/);
    expect(everything).not.toMatch(/v1:[\w-]+:[A-Za-z0-9+/=]{16}:/);
  });
});
