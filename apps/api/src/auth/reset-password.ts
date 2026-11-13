import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { MetaDb } from '../meta-db/meta-db.js';
import { auditLogs, sessions, users } from '../meta-db/schema.js';
import { PasswordHasher } from './password-hasher.js';

/** 운영 CLI(`reset-password`)가 만든 임시 비밀번호의 바이트 수. base64url로 24자다 */
const TEMP_PASSWORD_BYTES = 18;

export class ResetPasswordError extends Error {
  override readonly name = 'ResetPasswordError';
}

export interface ResetPasswordResult {
  userId: number;
  username: string;
  password: string;
  /** 비활성 계정이면 비밀번호를 바꿔도 로그인할 수 없다. 다른 관리자가 다시 활성화해야 한다 */
  active: boolean;
  revokedSessions: number;
}

/**
 * 관리자 비밀번호 되살리기 (B-36, 운영 런북 "비밀번호 분실"). 화면의 비밀번호 초기화(`users.service`)와 같이
 * 새 해시를 넣고 실패 횟수·잠금을 풀고 그 사용자의 세션을 모두 끊는다. 임시 비밀번호는 여기서 만들어 한 번만 돌려준다.
 * 감사 로그에는 시스템 작업으로 `user.password_reset`(사유 `cli`)을 남긴다.
 * 서버가 멈춘 상태에서 호출해야 한다(CLI가 인스턴스 락으로 확인한다).
 */
export async function resetPasswordOffline(
  db: MetaDb,
  username: string,
  now: number,
): Promise<ResetPasswordResult> {
  const name = username.trim().toLowerCase();
  const user = db.select().from(users).where(eq(users.username, name)).get();
  if (!user) throw new ResetPasswordError(`없는 아이디입니다: ${name}`);

  const password = randomBytes(TEMP_PASSWORD_BYTES).toString('base64url');
  const passwordHash = await new PasswordHasher().hash(password);
  const revokedSessions = db.transaction((tx) => {
    tx.update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, user.id))
      .run();
    const revoked = tx.delete(sessions).where(eq(sessions.userId, user.id)).run().changes;
    tx.insert(auditLogs)
      .values({
        at: now,
        userId: null,
        username: null,
        ip: null,
        requestId: null,
        action: 'user.password_reset',
        targetType: 'user',
        target: { id: user.id, username: user.username },
        after: { passwordChanged: true },
        result: 'success',
        reason: 'cli',
      })
      .run();
    return revoked;
  });
  return {
    userId: user.id,
    username: user.username,
    password,
    active: user.isActive,
    revokedSessions,
  };
}
