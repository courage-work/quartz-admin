import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { CreateUserRequest, UserDto } from '@qa/shared';
import { asc, count, eq, sql } from 'drizzle-orm';
import { ApiError, notFound } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { users } from '../meta-db/schema.js';
import { PasswordHasher } from './password-hasher.js';
import { LOCKOUT_MS, MAX_FAILED_LOGINS } from './policy.js';
import { SessionsService } from './sessions.service.js';

export type UserRow = typeof users.$inferSelect;

export function toUserDto(row: UserRow, now: number): UserDto {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.isAdmin,
    isActive: row.isActive,
    lockedUntil: row.lockedUntil !== null && row.lockedUntil > now ? row.lockedUntil : null,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const notAllowed = (message: string) =>
  new ApiError(HttpStatus.CONFLICT, 'OPERATION_NOT_ALLOWED', message);

/** 사용자 저장소와 관리 기능 (PRD FR-USR-02, 03, 05) */
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly metaDb: MetaDbService,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureInitialAdmin();
  }

  /** `users`가 비어 있을 때만 환경변수의 관리자를 만든다 (FR-USR-02) */
  async ensureInitialAdmin(): Promise<UserDto | null> {
    if (this.count() > 0) return null;
    const admin = this.config.admin;
    if (!admin) {
      this.logger.warn(
        '사용자가 없습니다. QA_ADMIN_USERNAME과 QA_ADMIN_PASSWORD를 지정하고 다시 시작하면 초기 관리자가 만들어집니다.',
      );
      return null;
    }
    const created = await this.create({ ...admin, isAdmin: true });
    this.logger.log(`초기 관리자를 만들었습니다: ${created.username}`);
    return created;
  }

  count(): number {
    return this.metaDb.db.select({ n: count() }).from(users).get()?.n ?? 0;
  }

  findById(id: number): UserRow | undefined {
    return this.metaDb.db.select().from(users).where(eq(users.id, id)).get();
  }

  findByUsername(username: string): UserRow | undefined {
    return this.metaDb.db.select().from(users).where(eq(users.username, username)).get();
  }

  list(): UserDto[] {
    const now = this.clock();
    return this.metaDb.db
      .select()
      .from(users)
      .orderBy(asc(users.username))
      .all()
      .map((row) => toUserDto(row, now));
  }

  async create(input: Required<CreateUserRequest>): Promise<UserDto> {
    if (this.findByUsername(input.username)) throw usernameTaken(input.username);
    const passwordHash = await this.hasher.hash(input.password);
    const now = this.clock();
    try {
      const row = this.metaDb.db
        .insert(users)
        .values({
          username: input.username,
          passwordHash,
          isAdmin: input.isAdmin,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      return toUserDto(row, now);
    } catch (err) {
      // 해시를 계산하는 사이에 같은 아이디가 먼저 들어온 경우
      if (isUniqueViolation(err)) throw usernameTaken(input.username);
      throw err;
    }
  }

  /**
   * 활성/비활성 전환 (FR-USR-03). 비활성화하면 그 사용자의 세션을 모두 끊는다.
   * 호출자는 활성 관리자이고 본인은 비활성화할 수 없으므로, 활성 관리자가 0명이 되는 일은 없다.
   */
  setActive(actorId: number, id: number, isActive: boolean): UserDto {
    this.require(id);
    if (!isActive && id === actorId) throw notAllowed('본인 계정은 비활성화할 수 없습니다');
    const now = this.clock();
    const row = this.metaDb.db
      .update(users)
      .set({ isActive, updatedAt: now })
      .where(eq(users.id, id))
      .returning()
      .get();
    if (!isActive) this.sessions.revokeAllForUser(id);
    return toUserDto(row, now);
  }

  /** 관리자의 비밀번호 초기화 (FR-USR-03). 잠금을 풀고 기존 세션을 모두 끊는다 */
  async resetPassword(id: number, password: string): Promise<void> {
    this.require(id);
    await this.setPassword(id, password);
    this.sessions.revokeAllForUser(id);
  }

  /** 본인 비밀번호 변경 (FR-USR-05). 지금 쓰는 세션만 남기고 나머지를 끊는다 */
  async changeOwnPassword(
    id: number,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = this.require(id);
    if (!(await this.hasher.verify(user.passwordHash, currentPassword))) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'WRONG_PASSWORD', '현재 비밀번호가 맞지 않습니다');
    }
    await this.setPassword(id, newPassword);
    this.sessions.revokeAllForUser(id, currentSessionId);
  }

  /**
   * 로그인 실패를 기록한다. 실패가 `MAX_FAILED_LOGINS`회 이어지면 `LOCKOUT_MS` 동안 잠그고 횟수를 0으로 되돌린다.
   * @returns 이번 실패로 잠겼으면 잠금 해제 시각
   */
  recordLoginFailure(id: number): number | null {
    const now = this.clock();
    return this.metaDb.db.transaction((tx) => {
      const row = tx
        .update(users)
        .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
        .where(eq(users.id, id))
        .returning({ failedLoginCount: users.failedLoginCount })
        .get();
      if (!row || row.failedLoginCount < MAX_FAILED_LOGINS) return null;
      const lockedUntil = now + LOCKOUT_MS;
      tx.update(users)
        .set({ failedLoginCount: 0, lockedUntil, updatedAt: now })
        .where(eq(users.id, id))
        .run();
      return lockedUntil;
    });
  }

  recordLoginSuccess(id: number): void {
    this.metaDb.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: this.clock() })
      .where(eq(users.id, id))
      .run();
  }

  private async setPassword(id: number, password: string): Promise<void> {
    const passwordHash = await this.hasher.hash(password);
    this.metaDb.db
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: this.clock() })
      .where(eq(users.id, id))
      .run();
  }

  private require(id: number): UserRow {
    const row = this.findById(id);
    if (!row) throw notFound('사용자를 찾을 수 없습니다');
    return row;
  }
}

function usernameTaken(username: string): ApiError {
  return new ApiError(HttpStatus.CONFLICT, 'USERNAME_TAKEN', `이미 있는 아이디입니다: ${username}`);
}

/** drizzle이 드라이버 오류를 `cause`로 감싸는 경우도 함께 본다 */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}
