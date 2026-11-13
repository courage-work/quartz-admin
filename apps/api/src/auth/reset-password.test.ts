import type { AuditLogPage } from '@qa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetaDb, openSqlite, runMigrations } from '../meta-db/meta-db.js';
import { tempDataDir } from '../meta-db/test-support.js';
import { ResetPasswordError, resetPasswordOffline } from './reset-password.js';
import { ADMIN, createTestApp, type TestApp } from './test-support.js';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  cleanup?.();
  cleanup = undefined;
});

/** 서버가 멈춘 상태에서 CLI가 하듯 메타 DB를 열어 되살린다 */
async function resetOffline(dataDir: string, username: string) {
  const sqlite = openSqlite(dataDir);
  try {
    const db = createMetaDb(sqlite);
    runMigrations(db);
    return await resetPasswordOffline(db, username, Date.now());
  } finally {
    sqlite.close();
  }
}

describe('관리자 비밀번호 되살리기 (운영 CLI reset-password)', () => {
  it('임시 비밀번호로 바꾸고 잠금을 풀며 세션을 끊고 감사 로그에 남긴다', async () => {
    const tmp = tempDataDir();
    cleanup = tmp.cleanup;
    const first = await createTestApp({ dataDir: tmp.dir });
    const oldSession = await first.login(ADMIN.username, ADMIN.password);
    // 5번 틀려 잠근다
    for (let i = 0; i < 5; i++) {
      await first.send('post', '/auth/login', {
        username: ADMIN.username,
        password: 'wrong-pass-1',
      });
    }
    const locked = await first.send('post', '/auth/login', {
      username: ADMIN.username,
      password: ADMIN.password,
    });
    expect(locked.status).toBe(423);
    const encryption = first.config.encryption;
    await first.close();

    const result = await resetOffline(tmp.dir, ADMIN.username.toUpperCase());
    expect(result).toMatchObject({ username: ADMIN.username, active: true, revokedSessions: 1 });
    expect(result.password).toMatch(/^[A-Za-z0-9_-]{24}$/);

    t = await createTestApp({ dataDir: tmp.dir, config: { encryption } });
    await t.get('/auth/me', oldSession).expect(401);
    const old = await t.send('post', '/auth/login', {
      username: ADMIN.username,
      password: ADMIN.password,
    });
    expect(old.status).toBe(401);
    const cookie = await t.login(ADMIN.username, result.password);
    const logs = (await t.get('/audit-logs?action=user.password_reset', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items).toHaveLength(1);
    expect(logs.items[0]).toMatchObject({
      result: 'success',
      userId: null,
      username: null,
      reason: 'cli',
      targetType: 'user',
      target: { username: ADMIN.username },
      after: { passwordChanged: true },
    });
  });

  it('없는 아이디면 아무것도 바꾸지 않고 알린다', async () => {
    const tmp = tempDataDir();
    cleanup = tmp.cleanup;
    const first = await createTestApp({ dataDir: tmp.dir });
    await first.close();
    await expect(resetOffline(tmp.dir, 'nobody')).rejects.toBeInstanceOf(ResetPasswordError);
    await expect(resetOffline(tmp.dir, 'nobody')).rejects.toThrow('없는 아이디입니다: nobody');
  });
});
