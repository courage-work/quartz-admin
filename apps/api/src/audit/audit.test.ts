import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpStatus } from '@nestjs/common';
import type { AuditLogDto, AuditLogPage } from '@qa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp } from '../auth/test-support.js';
import { ApiError } from '../common/api-error.js';
import { MaintenanceService } from '../meta-db/maintenance.service.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { tempDataDir } from '../meta-db/test-support.js';
import { AuditService, SYSTEM_ACTOR } from './audit.service.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(options?: Parameters<typeof createTestApp>[0]): Promise<TestApp> {
  t = await createTestApp(options);
  return t;
}

/** 저장된 행을 그대로 읽는다. JSON 컬럼은 문자열 그대로다 */
function rawRows(app: TestApp): Record<string, unknown>[] {
  return app.app
    .get(MetaDbService)
    .sqlite.prepare('SELECT * FROM audit_logs ORDER BY id')
    .all() as Record<string, unknown>[];
}

async function logs(app: TestApp, cookie: string, query = ''): Promise<AuditLogPage> {
  const res = await app.get(`/audit-logs${query}`, cookie).expect(200);
  return res.body as AuditLogPage;
}

function byAction(page: AuditLogPage, action: string): AuditLogDto[] {
  return page.items.filter((i) => i.action === action);
}

describe('기록 지점', () => {
  it('초기 관리자 생성을 시스템 작업으로 남긴다', async () => {
    const app = await start();
    const cookie = await app.login(ADMIN.username, ADMIN.password);
    const [created] = byAction(await logs(app, cookie), 'user.create');
    expect(created).toMatchObject({
      userId: null,
      username: null,
      targetType: 'user',
      target: { id: 1, username: 'admin' },
      after: { isAdmin: true, isActive: true },
      result: 'success',
    });
    expect(created?.reason).toContain('초기 관리자');
  });

  it('로그인 성공에 사용자, IP, 요청 ID를 남긴다', async () => {
    const app = await start();
    const res = await app.send('post', '/auth/login', { ...ADMIN }).expect(200);
    const requestId = res.headers['x-request-id'] as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const row = rawRows(app).find((r) => r.action === 'auth.login');
    expect(row).toMatchObject({
      user_id: 1,
      username: 'admin',
      request_id: requestId,
      result: 'success',
    });
    expect(row?.ip).toEqual(expect.stringMatching(/127\.0\.0\.1|::1/));
  });

  it('형식이 맞는 요청 ID 헤더는 이어 쓰고, 아니면 새로 만든다', async () => {
    const app = await start();
    const ok = await app
      .send('post', '/auth/login', { ...ADMIN })
      .set('X-Request-Id', 'proxy-req-12345')
      .expect(200);
    expect(ok.headers['x-request-id']).toBe('proxy-req-12345');
    const bad = await app
      .send('post', '/auth/login', { ...ADMIN })
      .set('X-Request-Id', '<script>alert(1)</script>')
      .expect(200);
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('로그인 실패를 원인과 함께 남기고, 없는 아이디도 입력한 아이디로 남긴다', async () => {
    const app = await start();
    await app.send('post', '/auth/login', { username: 'admin', password: 'wrong-pw' }).expect(401);
    await app.send('post', '/auth/login', { username: 'Ghost', password: 'whatever' }).expect(401);

    const rows = rawRows(app).filter((r) => r.action === 'auth.login');
    expect(rows).toMatchObject([
      { user_id: 1, username: 'admin', result: 'failure', error_code: 'INVALID_CREDENTIALS' },
      { user_id: null, username: 'ghost', result: 'failure', error_code: 'INVALID_CREDENTIALS' },
    ]);
    // 입력한 비밀번호는 어디에도 남지 않는다
    expect(JSON.stringify(rawRows(app))).not.toMatch(/wrong-pw|whatever/);
  });

  it('계정 잠금을 남기고, 속도 제한에 걸린 요청은 남기지 않는다', async () => {
    const app = await start({ loginRateLimit: 6 });
    for (let i = 0; i < 5; i++) {
      await app.send('post', '/auth/login', { username: 'admin', password: 'wrong-pw' });
    }
    await app.send('post', '/auth/login', { ...ADMIN }).expect(423);
    await app.send('post', '/auth/login', { ...ADMIN }).expect(429);

    const rows = rawRows(app).filter((r) => r.action === 'auth.login');
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.error_code)).toEqual([
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'ACCOUNT_LOCKED',
      'ACCOUNT_LOCKED',
    ]);
  });

  it('사용자 추가, 비활성화, 재활성화, 비밀번호 초기화를 전후 값과 함께 남긴다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const created = await app
      .send('post', '/users', { username: 'alice', password: 'alice-secret-1' }, admin)
      .expect(201);
    const id = (created.body as { id: number }).id;
    await app.send('patch', `/users/${id}`, { isActive: false }, admin).expect(200);
    await app.send('patch', `/users/${id}`, { isActive: true }, admin).expect(200);
    await app
      .send('post', `/users/${id}/reset-password`, { password: 'alice-reset-22' }, admin)
      .expect(204);

    const page = await logs(app, admin);
    const actor = { userId: 1, username: 'admin' };
    const target = { id, username: 'alice' };
    expect(byAction(page, 'user.create')[0]).toMatchObject({
      ...actor,
      target,
      after: { isAdmin: false, isActive: true },
      result: 'success',
    });
    expect(byAction(page, 'user.deactivate')[0]).toMatchObject({
      ...actor,
      target,
      before: { isActive: true },
      after: { isActive: false },
      result: 'success',
    });
    expect(byAction(page, 'user.activate')[0]).toMatchObject({
      before: { isActive: false },
      after: { isActive: true },
    });
    expect(byAction(page, 'user.password_reset')[0]).toMatchObject({
      ...actor,
      target,
      after: { passwordChanged: true },
      result: 'success',
    });
    expect(JSON.stringify(rawRows(app))).not.toMatch(/alice-secret-1|alice-reset-22/);
  });

  it('실패한 사용자 관리 작업도 오류 코드와 함께 남긴다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    await app
      .send('post', '/users', { username: 'admin', password: 'another-pass-1' }, admin)
      .expect(409);
    await app.send('patch', '/users/1', { isActive: false }, admin).expect(409);
    await app.send('patch', '/users/999', { isActive: false }, admin).expect(404);

    const failures = (await logs(app, admin, '?result=failure')).items.reverse();
    expect(failures).toMatchObject([
      { action: 'user.create', target: { username: 'admin' }, errorCode: 'USERNAME_TAKEN' },
      { action: 'user.deactivate', target: { id: 1 }, errorCode: 'OPERATION_NOT_ALLOWED' },
      { action: 'user.deactivate', target: { id: 999, username: null }, errorCode: 'NOT_FOUND' },
    ]);
    expect(failures[0]?.errorMessage).toContain('이미 있는 아이디');
  });

  it('본인 비밀번호 변경은 값 없이 "변경됨"만 남기고, 현재 비밀번호가 틀리면 실패로 남긴다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    await app
      .send(
        'put',
        '/auth/password',
        { currentPassword: 'nope-nope', newPassword: 'new-pass-123' },
        admin,
      )
      .expect(400);
    await app
      .send(
        'put',
        '/auth/password',
        { currentPassword: ADMIN.password, newPassword: 'new-pass-123' },
        admin,
      )
      .expect(204);

    const changes = byAction(await logs(app, admin), 'auth.password_change').reverse();
    expect(changes).toMatchObject([
      { result: 'failure', errorCode: 'WRONG_PASSWORD', after: null },
      { result: 'success', target: { id: 1, username: 'admin' }, after: { passwordChanged: true } },
    ]);
    expect(JSON.stringify(rawRows(app))).not.toMatch(/new-pass-123|nope-nope|admin-password-1/);
  });

  it('유효한 세션으로 로그아웃하면 남긴다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    await app.send('post', '/auth/logout', undefined, admin).expect(204);
    // 세션 없이 로그아웃하면 남기지 않는다
    await app.send('post', '/auth/logout').expect(204);
    const rows = rawRows(app).filter((r) => r.action === 'auth.logout');
    expect(rows).toMatchObject([{ user_id: 1, username: 'admin', result: 'success' }]);
  });
});

describe('조회 API', () => {
  it('로그인해야 볼 수 있고, 일반 사용자도 볼 수 있다', async () => {
    const app = await start();
    await app.get('/audit-logs').expect(401);
    const admin = await app.login(ADMIN.username, ADMIN.password);
    await app.send('post', '/users', { username: 'bob', password: 'bob-password-1' }, admin);
    const bob = await app.login('bob', 'bob-password-1');
    const page = await logs(app, bob);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('작업 종류, 결과, 사용자, 기간으로 거른다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password); // t0
    const t0 = app.clock.now;
    app.clock.advance(60_000);
    await app.send('post', '/auth/login', { username: 'ghost', password: 'x' }).expect(401); // t1
    app.clock.advance(60_000);
    await app.send('post', '/users', { username: 'carol', password: 'carol-pass-1' }, admin); // t2

    const actions = (p: AuditLogPage) => p.items.map((i) => i.action);
    expect(actions(await logs(app, admin, '?action=user.create'))).toEqual([
      'user.create',
      'user.create',
    ]);
    expect((await logs(app, admin, '?result=failure')).items).toMatchObject([
      { action: 'auth.login', username: 'ghost' },
    ]);
    expect(actions(await logs(app, admin, '?username=ghost'))).toEqual(['auth.login']);
    expect(actions(await logs(app, admin, '?userId=1'))).toEqual(['user.create', 'auth.login']);
    expect(actions(await logs(app, admin, `?from=${t0 + 1}&to=${t0 + 60_001}`))).toEqual([
      'auth.login',
    ]);
    expect((await logs(app, admin, `?from=${t0 + 120_000}`)).items).toMatchObject([
      { action: 'user.create', target: { username: 'carol' } },
    ]);
  });

  it('최신 기록부터 커서로 나눠 준다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    for (let i = 0; i < 4; i++) {
      await app.send('post', '/auth/login', { username: `nobody${i}`, password: 'x' });
    }
    // 초기 관리자 생성 1 + 로그인 성공 1 + 실패 4 = 6건
    const first = await logs(app, admin, '?limit=4');
    expect(first.items.map((i) => i.id)).toEqual([6, 5, 4, 3]);
    expect(first.nextCursor).toBe(3);
    const second = await logs(app, admin, `?limit=4&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.id)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
  });

  it('잘못된 쿼리는 400으로 거부한다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    for (const q of [
      '?limit=1000',
      '?limit=0',
      '?from=10&to=10',
      '?action=drop.table',
      '?result=ok',
      '?userId=abc',
    ]) {
      const res = await app.get(`/audit-logs${q}`, admin).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('무결성 (FR-AUD-04)', () => {
  it('감사 로그를 수정하거나 삭제하는 API 경로가 없다', async () => {
    const app = await start();
    const admin = await app.login(ADMIN.username, ADMIN.password);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const path of ['/audit-logs', '/audit-logs/1']) {
        const res = await app.send(method, path, {}, admin);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    await app.get('/audit-logs/1', admin).expect(404);
    expect(rawRows(app)).toHaveLength(2);
  });

  it('앱 코드에서 audit_logs를 바꾸는 곳은 AuditService뿐이다', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/\.(update|delete)\(auditLogs\)|(UPDATE|DELETE FROM)\s+audit_logs/i.test(text)) {
            offenders.push(relative(srcDir, path).replaceAll('\\', '/'));
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual(['audit/audit.service.ts']);
  });

  it('pending 결과는 한 번만 정해지고, 처리하지 못한 예외의 내부 메시지는 남기지 않는다', async () => {
    const app = await start();
    const audit = app.app.get(AuditService);
    const entry = { actor: SYSTEM_ACTOR, action: 'user.create' as const };

    const pending = audit.begin(entry);
    pending.succeed({ after: { ok: 1 } });
    pending.fail(new Error('late'));
    expect(audit.complete(pending.id, { result: 'failure' })).toBe(false);

    await expect(
      audit.run(entry, () => {
        throw new Error('ORA-01017: invalid username/password; host=db.internal');
      }),
    ).rejects.toThrow('ORA-01017');
    await expect(
      audit.run(entry, () => {
        throw new ApiError(HttpStatus.CONFLICT, 'USERNAME_TAKEN', '이미 있는 아이디입니다: x');
      }),
    ).rejects.toThrow(ApiError);

    const rows = rawRows(app).slice(-3);
    expect(rows).toMatchObject([
      { result: 'success', after: '{"ok":1}', error_code: null },
      { result: 'failure', error_code: 'INTERNAL_ERROR', error_message: '처리하지 못한 서버 오류' },
      {
        result: 'failure',
        error_code: 'USERNAME_TAKEN',
        error_message: '이미 있는 아이디입니다: x',
      },
    ]);
  });

  it('기동할 때 pending으로 남은 기록을 failure(INTERRUPTED)로 정리한다', async () => {
    const tmp = tempDataDir();
    try {
      const first = await createTestApp({ dataDir: tmp.dir });
      const id = first.app
        .get(AuditService)
        .begin({ actor: SYSTEM_ACTOR, action: 'user.create' }).id;
      await first.close();

      t = await createTestApp({ dataDir: tmp.dir });
      const row = rawRows(t).find((r) => r.id === id);
      expect(row).toMatchObject({ result: 'failure', error_code: 'INTERRUPTED' });
      expect(rawRows(t).filter((r) => r.result === 'pending')).toEqual([]);
    } finally {
      await t?.close();
      t = undefined;
      tmp.cleanup();
    }
  });

  it('보존 기간이 지난 기록만 일일 정리 작업에서 지운다', async () => {
    const app = await start({ config: { auditRetentionDays: 30 } });
    const audit = app.app.get(AuditService);
    const day = 86_400_000;
    const base = app.clock.now;
    // 31일 전, 29일 전 기록
    app.clock.now = base - 31 * day;
    audit.success({ actor: SYSTEM_ACTOR, action: 'auth.logout' });
    app.clock.now = base - 29 * day;
    audit.success({ actor: SYSTEM_ACTOR, action: 'auth.login' });
    app.clock.now = base;

    const report = await app.app.get(MaintenanceService).runOnce(new Date(base));
    // 초기 관리자 생성 기록(base 시각)과 29일 전 기록이 남는다
    expect(report.tasks).toContainEqual({ name: 'audit_logs', removed: 1 });
    expect(rawRows(app).map((r) => r.action)).toEqual(['user.create', 'auth.login']);
  });
});
