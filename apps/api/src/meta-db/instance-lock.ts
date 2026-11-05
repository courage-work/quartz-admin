/**
 * 단일 인스턴스 락 (TRD §3.1, PRD NFR-REL-04)
 *
 * 같은 데이터 디렉터리를 두 프로세스가 쓰면 감시와 알림 발송이 중복되므로,
 * 최근 하트비트가 남아 있는 다른 인스턴스가 있으면 기동을 거부한다.
 *
 * 락 행은 마이그레이션보다 먼저 확보해야 하므로(동시 마이그레이션 방지)
 * drizzle 스키마가 아닌 전용 테이블을 직접 만든다.
 * 이 파일은 데코레이터를 쓰지 않는다. 테스트가 자식 프로세스에서 Node 타입 제거로 직접 실행한다.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface LockHolder {
  instanceId: string;
  host: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface InstanceLockOptions {
  instanceId?: string;
  host?: string;
  pid?: number;
  /** 이 시간보다 오래된 하트비트는 죽은 인스턴스로 본다 */
  staleAfterMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

export class InstanceLockError extends Error {
  readonly holder: LockHolder;

  constructor(holder: LockHolder, ageMs: number) {
    super(
      `다른 quartz-admin 인스턴스가 같은 데이터 디렉터리를 사용 중이라 기동을 중단합니다 ` +
        `(host=${holder.host}, pid=${holder.pid}, 마지막 하트비트 ${Math.round(ageMs / 1000)}초 전). ` +
        `quartz-admin은 단일 인스턴스로만 실행할 수 있습니다. 기존 인스턴스를 종료한 뒤 다시 시작하세요.`,
    );
    this.name = 'InstanceLockError';
    this.holder = holder;
  }
}

interface LockRow {
  instance_id: string;
  host: string;
  pid: number;
  started_at: number;
  heartbeat_at: number;
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: 프로세스는 있지만 신호 권한이 없음
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class InstanceLock {
  readonly instanceId: string;
  private readonly sqlite: Database.Database;
  private readonly host: string;
  private readonly pid: number;
  private readonly staleAfterMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private timer: NodeJS.Timeout | undefined;

  constructor(sqlite: Database.Database, options: InstanceLockOptions = {}) {
    this.sqlite = sqlite;
    this.instanceId = options.instanceId ?? randomUUID();
    this.host = options.host ?? hostname();
    this.pid = options.pid ?? process.pid;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  }

  /** 락을 확보한다. 살아 있는 다른 인스턴스가 있으면 InstanceLockError */
  acquire(): void {
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS instance_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id TEXT NOT NULL,
      host TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    )`);

    const take = this.sqlite.transaction(() => {
      this.check();
      const now = this.now();
      this.sqlite
        .prepare(
          `INSERT INTO instance_lock (id, instance_id, host, pid, started_at, heartbeat_at)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET instance_id = excluded.instance_id, host = excluded.host,
             pid = excluded.pid, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
        )
        .run(this.instanceId, this.host, this.pid, now, now);
    });
    // BEGIN IMMEDIATE: 두 프로세스가 동시에 읽고 둘 다 비어 있다고 판단하는 경합을 막는다
    take.immediate();
  }

  /** 살아 있는 다른 보유자가 있으면 InstanceLockError. 아무것도 기록하지 않는다 */
  check(): void {
    const row = this.readRow();
    const now = this.now();
    if (row && row.instance_id !== this.instanceId && !this.isStale(row, now)) {
      throw new InstanceLockError(toHolder(row), now - row.heartbeat_at);
    }
  }

  /** 하트비트를 갱신한다. 락을 잃었으면 false */
  beat(): boolean {
    const result = this.sqlite
      .prepare('UPDATE instance_lock SET heartbeat_at = ? WHERE id = 1 AND instance_id = ?')
      .run(this.now(), this.instanceId);
    return result.changes === 1;
  }

  startHeartbeat(onLost: () => void): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      if (!this.beat()) {
        this.stopHeartbeat();
        onLost();
      }
    }, this.heartbeatIntervalMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  release(): void {
    this.stopHeartbeat();
    this.sqlite
      .prepare('DELETE FROM instance_lock WHERE id = 1 AND instance_id = ?')
      .run(this.instanceId);
  }

  holder(): LockHolder | undefined {
    const row = this.readRow();
    return row && toHolder(row);
  }

  private readRow(): LockRow | undefined {
    try {
      return this.sqlite.prepare('SELECT * FROM instance_lock WHERE id = 1').get() as
        LockRow | undefined;
    } catch (err) {
      // 처음 기동하는 데이터 디렉터리에는 아직 테이블이 없다
      if (err instanceof Error && /no such table/.test(err.message)) return undefined;
      throw err;
    }
  }

  private isStale(row: LockRow, now: number): boolean {
    if (now - row.heartbeat_at > this.staleAfterMs) return true;
    if (row.host === this.host) {
      // 같은 호스트: 컨테이너 재시작(pid 재사용)이거나 이미 죽은 프로세스면 인수한다
      return row.pid === this.pid || !this.isPidAlive(row.pid);
    }
    return false;
  }
}

function toHolder(row: LockRow): LockHolder {
  return {
    instanceId: row.instance_id,
    host: row.host,
    pid: row.pid,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
  };
}
