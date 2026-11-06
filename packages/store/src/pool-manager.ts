import { createHash } from 'node:crypto';
import type { ConnectOptions, DriverAdapter, TargetConn, TargetConnectInfo } from './adapter.js';
import type { DbKind } from './db-kind.js';
import { TargetError, isTargetError } from './errors.js';

/** 풀 설정. 기본값은 TRD §5.2 */
export interface PoolOptions {
  /** 접속당 최대 커넥션. 기본 2 (NFR-PERF-04) */
  maxConnections: number;
  /** 이 시간 동안 쓰지 않은 커넥션을 닫는다. 기본 60초 */
  idleTimeoutMs: number;
  /** 연결 수립 제한. 기본 10초 */
  connectTimeoutMs: number;
  /** 커넥션이 모두 사용 중일 때 기다리는 시간. 넘으면 `TARGET_BUSY`. 기본 10초 */
  acquireTimeoutMs: number;
  /** 커넥션 기본 쿼리 실행 제한. 기본 10초 */
  queryTimeoutMs: number;
}

export const DEFAULT_POOL_OPTIONS: Readonly<PoolOptions> = Object.freeze({
  maxConnections: 2,
  idleTimeoutMs: 60_000,
  connectTimeoutMs: 10_000,
  acquireTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});

/** 풀을 나누는 단위. 메타 저장소의 접속(connection) 하나다 */
export interface PoolTarget {
  /** 접속 ID */
  id: string | number;
  info: TargetConnectInfo;
}

export interface PoolStats {
  idle: number;
  inUse: number;
  connecting: number;
  waiting: number;
}

interface IdleEntry {
  conn: TargetConn;
  timer: NodeJS.Timeout;
}

interface Waiter {
  resolve: (conn: TargetConn) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * 접속 하나의 커넥션 풀. 드라이버 풀 대신 직접 관리하는 이유는 DB 4종에서 대기 제한, 유휴 종료,
 * 연결 제한을 같은 규칙으로 맞추기 위해서다(mysql2 풀에는 대기 제한이 없다).
 *
 * - 커넥션은 처음 요청할 때 연다. 연결 중인 것도 개수에 넣어 최대 개수를 넘지 않는다
 * - 연결 제한을 넘으면 호출자에게는 바로 `TARGET_TIMEOUT`을 주지만, 드라이버의 연결 시도가 끝날 때까지
 *   자리를 비우지 않는다. 응답 없는 대상에 소켓이 계속 쌓이지 않게 하려는 것이다
 */
class TargetPool {
  private readonly idle: IdleEntry[] = [];
  private readonly waiters: Waiter[] = [];
  private inUse = 0;
  private connecting = 0;
  private closed = false;

  constructor(
    readonly fingerprint: string,
    private readonly adapter: DriverAdapter,
    private readonly info: TargetConnectInfo,
    private readonly options: PoolOptions,
  ) {}

  get stats(): PoolStats {
    return {
      idle: this.idle.length,
      inUse: this.inUse,
      connecting: this.connecting,
      waiting: this.waiters.length,
    };
  }

  private get size(): number {
    return this.idle.length + this.inUse + this.connecting;
  }

  acquire(): Promise<TargetConn> {
    const entry = this.idle.pop();
    if (entry) {
      clearTimeout(entry.timer);
      this.inUse++;
      return Promise.resolve(entry.conn);
    }
    if (this.size < this.options.maxConnections) {
      return this.open();
    }
    return new Promise<TargetConn>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(
            new TargetError('TARGET_BUSY', {
              detail: `커넥션 대기가 ${this.options.acquireTimeoutMs}ms를 넘었습니다`,
            }),
          );
        }, this.options.acquireTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** 커넥션을 돌려놓는다. `discard`면 닫고 자리를 비운다 */
  release(conn: TargetConn, discard: boolean): void {
    this.inUse--;
    if (discard || this.closed) {
      void closeQuietly(conn);
      this.serveWaiters();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.inUse++;
      waiter.resolve(conn);
      return;
    }
    const entry: IdleEntry = {
      conn,
      timer: setTimeout(() => {
        const i = this.idle.indexOf(entry);
        if (i >= 0) {
          this.idle.splice(i, 1);
          void closeQuietly(conn);
        }
      }, this.options.idleTimeoutMs),
    };
    // 유휴 커넥션 때문에 프로세스가 종료되지 못하는 일이 없게 한다
    entry.timer.unref();
    this.idle.push(entry);
  }

  /** 풀을 닫는다. 유휴 커넥션은 바로 닫고, 사용 중인 것은 돌려받을 때 닫는다. 대기자는 취소한다 */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new TargetError('TARGET_ERROR', {
          message: '접속 설정이 바뀌거나 삭제되어 요청을 취소했습니다. 다시 시도하세요',
          retryable: true,
        }),
      );
    }
    const entries = this.idle.splice(0);
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map((entry) => closeQuietly(entry.conn)));
  }

  private open(): Promise<TargetConn> {
    this.connecting++;
    const { connectTimeoutMs, queryTimeoutMs } = this.options;
    const connectOptions: ConnectOptions = { connectTimeoutMs, queryTimeoutMs };
    return new Promise<TargetConn>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(
          new TargetError('TARGET_TIMEOUT', {
            message: '대상 DB 연결이 제한 시간 안에 이뤄지지 않았습니다',
            detail: `연결 수립이 ${connectTimeoutMs}ms를 넘었습니다`,
          }),
        );
      }, connectTimeoutMs);

      // 어댑터가 동기로 던져도 같은 경로로 처리한다
      const pending = Promise.resolve().then(() => this.adapter.connect(this.info, connectOptions));
      pending.then(
        (conn) => {
          clearTimeout(timer);
          this.connecting--;
          if (settled || this.closed) {
            // 호출자는 이미 시간 초과를 받았거나 풀이 닫혔다
            void closeQuietly(conn);
            if (!settled) {
              settled = true;
              reject(
                new TargetError('TARGET_ERROR', {
                  message: '접속 설정이 바뀌거나 삭제되어 요청을 취소했습니다. 다시 시도하세요',
                  retryable: true,
                }),
              );
            }
            this.serveWaiters();
            return;
          }
          settled = true;
          this.inUse++;
          resolve(conn);
        },
        (err: unknown) => {
          clearTimeout(timer);
          this.connecting--;
          if (!settled) {
            settled = true;
            reject(err instanceof Error ? err : new TargetError('TARGET_ERROR'));
          }
          this.serveWaiters();
        },
      );
    });
  }

  /** 자리가 나면 기다리던 요청에 새 커넥션을 연다 */
  private serveWaiters(): void {
    if (this.closed) return;
    while (this.waiters.length > 0 && this.size < this.options.maxConnections) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      this.open().then(waiter.resolve, waiter.reject);
    }
  }
}

async function closeQuietly(conn: TargetConn): Promise<void> {
  try {
    await conn.close();
  } catch {
    // 이미 끊긴 커넥션을 닫다 난 오류는 의미가 없다
  }
}

/** 접속 정보가 바뀌었는지 판단하는 값. 비밀번호도 포함하지만 해시라서 원문이 남지 않는다 */
function fingerprintOf(info: TargetConnectInfo): string {
  const entries = Object.entries(info)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * 대상 DB 커넥션 풀 관리자 (TRD §5.2, NFR-PERF-04, NFR-REL-01).
 *
 * 접속마다 독립된 풀을 둔다. 한 대상이 응답하지 않으면 그 접속의 요청만 기다리거나 실패하고,
 * 다른 접속의 요청은 영향을 받지 않는다. 같은 접속의 스케줄러들은 풀을 함께 쓴다.
 */
export class TargetPoolManager {
  private readonly adapters = new Map<DbKind, DriverAdapter>();
  private readonly pools = new Map<string, TargetPool>();
  private readonly options: PoolOptions;

  constructor(adapters: readonly DriverAdapter[], options: Partial<PoolOptions> = {}) {
    for (const adapter of adapters) this.adapters.set(adapter.kind, adapter);
    this.options = { ...DEFAULT_POOL_OPTIONS, ...options };
  }

  /**
   * 커넥션 하나를 빌려 `fn`을 실행하고 돌려놓는다.
   * 커밋하지 않은 트랜잭션이 남아 있으면 롤백한다. 끊긴 커넥션(`connectionBroken`)은 풀에 돌려놓지 않는다.
   */
  async withConnection<T>(target: PoolTarget, fn: (conn: TargetConn) => Promise<T>): Promise<T> {
    const pool = this.poolFor(target);
    const conn = await pool.acquire();
    let discard = false;
    try {
      return await fn(conn);
    } catch (err) {
      if (isTargetError(err) && err.connectionBroken) discard = true;
      throw err;
    } finally {
      if (!discard && conn.inTransaction) {
        try {
          await conn.rollback();
        } catch {
          discard = true;
        }
      }
      pool.release(conn, discard);
    }
  }

  /** 접속을 수정하거나 삭제했을 때 그 풀을 버린다. 사용 중인 커넥션은 돌려받는 즉시 닫힌다 */
  async invalidate(id: string | number): Promise<void> {
    const key = String(id);
    const pool = this.pools.get(key);
    if (!pool) return;
    this.pools.delete(key);
    await pool.close();
  }

  /** 앱 종료 시 모든 풀을 닫는다 */
  async closeAll(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((pool) => pool.close()));
  }

  stats(id: string | number): PoolStats | undefined {
    return this.pools.get(String(id))?.stats;
  }

  private poolFor(target: PoolTarget): TargetPool {
    const key = String(target.id);
    const fingerprint = fingerprintOf(target.info);
    const existing = this.pools.get(key);
    if (existing?.fingerprint === fingerprint) return existing;
    if (existing) {
      // 접속 정보가 바뀌었다. 이전 풀은 버리고 새로 만든다
      this.pools.delete(key);
      void existing.close();
    }
    const adapter = this.adapters.get(target.info.kind);
    if (!adapter) {
      throw new TargetError('TARGET_ERROR', {
        message: `아직 지원하지 않는 DB 종류입니다: ${target.info.kind}`,
      });
    }
    const pool = new TargetPool(fingerprint, adapter, target.info, this.options);
    this.pools.set(key, pool);
    return pool;
  }
}
