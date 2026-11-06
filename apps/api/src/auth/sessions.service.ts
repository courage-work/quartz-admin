import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, lte, ne } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { MaintenanceService } from '../meta-db/maintenance.service.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { sessions, users } from '../meta-db/schema.js';
import type { UserIdentity } from './auth-provider.js';
import { SESSION_ABSOLUTE_MS } from './policy.js';

export interface SessionContext {
  /** 토큰의 SHA-256 (sessions.id) */
  sessionId: string;
  user: UserIdentity;
}

/** DB에는 토큰 원문이 아니라 해시만 둔다. DB 파일이 새어도 세션을 가로챌 수 없게 하기 위해서다 */
export function sessionIdOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 서버 측 세션 (TRD §4.2)
 *
 * `expires_at`에는 유휴 만료와 절대 만료 중 이른 시각을 저장하고, 요청마다 다시 계산한다.
 * 만료된 세션은 조회 시점에 바로 무효가 되고, 행은 그때 또는 일일 보존 정리에서 지운다.
 */
@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly idleMs: number;

  constructor(
    private readonly metaDb: MetaDbService,
    private readonly maintenance: MaintenanceService,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.idleMs = config.sessionIdleMin * 60_000;
  }

  onModuleInit(): void {
    this.maintenance.register({ name: 'sessions', run: (now) => this.deleteExpired(now) });
  }

  /** 새 세션을 만들고 쿠키에 넣을 토큰 원문을 돌려준다 */
  create(userId: number, client: { ip?: string; userAgent?: string }): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock();
    this.metaDb.db
      .insert(sessions)
      .values({
        id: sessionIdOf(token),
        userId,
        ip: client.ip ?? null,
        userAgent: client.userAgent?.slice(0, 512) ?? null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: this.expiry(now, now),
      })
      .run();
    return token;
  }

  /** 유효한 세션이면 만료 시각을 연장하고 사용자를 돌려준다 */
  authenticate(token: string): SessionContext | null {
    const id = sessionIdOf(token);
    const now = this.clock();
    const row = this.metaDb.db
      .select({
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        username: users.username,
        isAdmin: users.isAdmin,
        isActive: users.isActive,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .get();
    if (!row) return null;
    if (row.expiresAt <= now || !row.isActive) {
      this.revoke(id);
      return null;
    }
    this.metaDb.db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: this.expiry(row.createdAt, now) })
      .where(eq(sessions.id, id))
      .run();
    return {
      sessionId: id,
      user: { id: row.userId, username: row.username, isAdmin: row.isAdmin },
    };
  }

  revoke(sessionId: string): void {
    this.metaDb.db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }

  /** 비밀번호 변경·초기화, 비활성화 시 호출. `exceptSessionId`는 남겨 둘 현재 세션 */
  revokeAllForUser(userId: number, exceptSessionId?: string): number {
    const where = exceptSessionId
      ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
      : eq(sessions.userId, userId);
    return this.metaDb.db.delete(sessions).where(where).run().changes;
  }

  deleteExpired(now: number): number {
    return this.metaDb.db.delete(sessions).where(lte(sessions.expiresAt, now)).run().changes;
  }

  private expiry(createdAt: number, now: number): number {
    return Math.min(createdAt + SESSION_ABSOLUTE_MS, now + this.idleMs);
  }
}
