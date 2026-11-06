import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../auth/test-support.js';
import { htmlCsp, inlineScriptHashes, WebAssets } from './web-assets.js';

const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

const INDEX_SCRIPT = '(self.__next_f=self.__next_f||[]).push([0])';
const USERS_SCRIPT = 'self.__next_f.push([1,"users"])';
const html = (title: string, script: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title><script src="/_next/static/chunks/a.js" async=""></script></head>` +
  `<body><script>${script}</script><script id="_R_">window.x=1</script></body></html>`;

let webDir: string;
beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), 'qa-web-'));
  writeFileSync(join(webDir, 'index.html'), html('홈', INDEX_SCRIPT));
  writeFileSync(join(webDir, 'users.html'), html('사용자', USERS_SCRIPT));
  writeFileSync(join(webDir, 'audit-log.html'), html('감사 기록', 'self.detail=1'));
  writeFileSync(join(webDir, '404.html'), html('없음', 'self.nf=1'));
  writeFileSync(join(webDir, 'users.txt'), 'rsc payload');
  mkdirSync(join(webDir, 'users'));
  mkdirSync(join(webDir, '_next', 'static', 'chunks'), { recursive: true });
  writeFileSync(join(webDir, '_next', 'static', 'chunks', 'a.js'), 'console.log(1)');
});
afterAll(() => rmSync(webDir, { recursive: true, force: true }));

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

function scriptSrc(csp: string): string[] {
  const directive = csp.split(/;\s*/).find((d) => d.startsWith('script-src '));
  return directive?.split(' ').slice(1) ?? [];
}

describe('inlineScriptHashes, htmlCsp', () => {
  it('src가 없는 인라인 스크립트만 해시한다', () => {
    expect(inlineScriptHashes(html('x', INDEX_SCRIPT))).toEqual([
      sha(INDEX_SCRIPT),
      sha('window.x=1'),
    ]);
  });

  it("helmet 기본값에 해시만 더하고 'unsafe-inline'은 쓰지 않는다", () => {
    const csp = htmlCsp([sha('a')], true);
    expect(scriptSrc(csp)).toEqual(["'self'", sha('a')]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('http로 서비스하면 upgrade-insecure-requests를 뺀다', () => {
    expect(htmlCsp([], false)).not.toContain('upgrade-insecure-requests');
  });
});

describe('WebAssets.resolve', () => {
  it('파일, <경로>.html 순서로 찾고 상위 디렉터리 이동은 막는다', () => {
    const assets = new WebAssets(webDir, false);
    expect(assets.resolve('/')).toBe('index.html');
    expect(assets.resolve('/users')).toBe('users.html');
    expect(assets.resolve('/users/')).toBe('users.html');
    expect(assets.resolve('/users.txt')).toBe('users.txt');
    expect(assets.resolve('/_next/static/chunks/a.js')).toBe('_next/static/chunks/a.js');
    expect(assets.resolve('/nope')).toBeNull();
    expect(assets.resolve('/../package.json')).toBeNull();
    expect(assets.resolve('/%2e%2e/package.json')).toBeNull();
    expect(assets.resolve('/%E0%A4%A')).toBeNull();
  });

  it('index.html이 없으면 화면을 서빙하지 않는다', () => {
    expect(WebAssets.load(join(webDir, 'missing'), false)).toBeNull();
    expect(WebAssets.load(null, false)).toBeNull();
  });
});

describe('화면 서빙 (TRD §2.2)', () => {
  it('화면과 API가 같은 오리진에서 동작한다', async () => {
    t = await createTestApp({ webDir });
    const page = await request(t.app.getHttpServer()).get('/').expect(200);
    expect(page.headers['content-type']).toContain('text/html');
    const api = await t.get('/auth/me').expect(401);
    expect(api.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('쿼리 파라미터 기반 상세 경로를 새로고침해도 해당 HTML을 준다', async () => {
    t = await createTestApp({ webDir });
    const server = t.app.getHttpServer();
    const res = await request(server).get('/audit-log?id=1').expect(200);
    expect(res.text).toContain('<title>감사 기록</title>');
    const users = await request(server).get('/users').expect(200);
    expect(users.text).toContain('<title>사용자</title>');
  });

  it('HTML마다 그 파일의 인라인 스크립트 해시만 CSP에 넣는다', async () => {
    t = await createTestApp({ webDir });
    const server = t.app.getHttpServer();
    const index = await request(server).get('/').expect(200);
    const users = await request(server).get('/users').expect(200);
    expect(scriptSrc(index.headers['content-security-policy'] as string)).toEqual([
      "'self'",
      sha(INDEX_SCRIPT),
      sha('window.x=1'),
    ]);
    expect(scriptSrc(users.headers['content-security-policy'] as string)).toEqual([
      "'self'",
      sha(USERS_SCRIPT),
      sha('window.x=1'),
    ]);
    expect(index.headers['cache-control']).toBe('no-cache');
    // 테스트 설정의 QA_PUBLIC_URL은 http다
    expect(index.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('API 응답의 CSP는 helmet 기본값 그대로다', async () => {
    t = await createTestApp({ webDir });
    const res = await t.get('/auth/me').expect(401);
    expect(scriptSrc(res.headers['content-security-policy'] as string)).toEqual(["'self'"]);
  });

  it('빌드 산출물은 오래 캐시한다', async () => {
    t = await createTestApp({ webDir });
    const res = await request(t.app.getHttpServer()).get('/_next/static/chunks/a.js').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('없는 화면 경로는 404.html을 404로, 없는 API 경로는 JSON 404를 준다', async () => {
    t = await createTestApp({ webDir });
    const server = t.app.getHttpServer();
    const page = await request(server).get('/no-such-page').expect(404);
    expect(page.text).toContain('<title>없음</title>');
    expect(scriptSrc(page.headers['content-security-policy'] as string)).toContain(
      sha('self.nf=1'),
    );
    const api = await request(server).get('/api/v1/no-such').expect(404);
    expect(api.body).toMatchObject({ code: 'NOT_FOUND' });
    // /api/v1 밖의 /api 경로도 화면 파일로 응답하지 않는다
    const apiRoot = await request(server).get('/api').expect(404);
    expect(apiRoot.text).not.toContain('<title>없음</title>');
  });

  it('GET/HEAD 이외의 요청은 화면 파일로 응답하지 않는다', async () => {
    t = await createTestApp({ webDir });
    const res = await request(t.app.getHttpServer())
      .post('/users')
      .set('Origin', t.config.publicOrigin)
      .set('X-QA-Request', '1')
      .expect(404);
    expect(res.text).not.toContain('<title>사용자</title>');
  });

  it('화면 디렉터리가 없으면 API만 제공한다', async () => {
    t = await createTestApp({ webDir: join(webDir, 'missing') });
    await request(t.app.getHttpServer()).get('/').expect(404);
    await t.get('/auth/me').expect(401);
  });
});
