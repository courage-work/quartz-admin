import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../auth/test-support.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('헬스체크 (TRD §11.1)', () => {
  it('/healthz와 /readyz는 API 접두어 밖에서 로그인 없이 응답한다', async () => {
    t = await createTestApp();
    const server = t.app.getHttpServer();
    const health = await request(server).get('/healthz').expect(200);
    expect(health.body).toEqual({ status: 'ok' });
    const ready = await request(server).get('/readyz').expect(200);
    expect(ready.body).toEqual({ status: 'ok', checks: { sqlite: 'ok', migrations: 'ok' } });
    // 접두어 안에는 없다
    await request(server).get('/api/v1/healthz').expect(404);
  });

  it('화면 파일이 있어도 헬스체크 경로는 가로채지 않는다', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const webDir = mkdtempSync(join(tmpdir(), 'qa-web-'));
    try {
      writeFileSync(join(webDir, 'index.html'), '<html></html>');
      writeFileSync(join(webDir, '404.html'), '<html>404</html>');
      t = await createTestApp({ webDir });
      const res = await request(t.app.getHttpServer()).get('/readyz').expect(200);
      expect(res.body).toMatchObject({ status: 'ok' });
    } finally {
      await t?.close();
      t = undefined;
      rmSync(webDir, { recursive: true, force: true });
    }
  });

  it('메타데이터 저장소를 읽을 수 없으면 /readyz가 503을 준다', async () => {
    t = await createTestApp();
    const server = t.app.getHttpServer();
    // 마이그레이션 기록이 사라진 상황을 흉내 낸다
    t.app.get(MetaDbService).sqlite.exec('DELETE FROM __drizzle_migrations');
    const res = await request(server).get('/readyz').expect(503);
    expect(res.body).toEqual({ status: 'error', checks: { sqlite: 'ok', migrations: 'error' } });
    // 프로세스 자체는 살아 있다
    await request(server).get('/healthz').expect(200);
  });
});
