import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectOptions, DriverAdapter, TargetConn, TargetConnectInfo } from './adapter.js';
import { TargetError } from './errors.js';
import { TargetPoolManager, type PoolTarget } from './pool-manager.js';

interface FakeConn extends TargetConn {
  readonly id: number;
  closed: boolean;
  dirty: boolean;
  rolledBack: number;
}

/** 연결을 직접 끝내거나 실패시킬 수 있는 가짜 어댑터 */
class FakeAdapter implements DriverAdapter {
  readonly kind = 'oracle' as const;
  /** true면 `connect`가 `release()`를 부를 때까지 끝나지 않는다 */
  hang = false;
  failWith: Error | undefined = undefined;
  readonly opened: FakeConn[] = [];
  readonly options: ConnectOptions[] = [];
  private pending: (() => void)[] = [];
  private seq = 0;

  connect(_info: TargetConnectInfo, options: ConnectOptions): Promise<TargetConn> {
    this.options.push(options);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const make = (): FakeConn => {
      const conn: FakeConn = {
        id: ++this.seq,
        kind: 'oracle',
        closed: false,
        dirty: false,
        rolledBack: 0,
        get inTransaction() {
          return this.dirty;
        },
        query: () => Promise.resolve([]),
        execute: () => {
          conn.dirty = true;
          return Promise.resolve(1);
        },
        commit: () => {
          conn.dirty = false;
          return Promise.resolve();
        },
        rollback: () => {
          conn.dirty = false;
          conn.rolledBack++;
          return Promise.resolve();
        },
        close: () => {
          conn.closed = true;
          return Promise.resolve();
        },
      };
      this.opened.push(conn);
      return conn;
    };
    if (!this.hang) return Promise.resolve(make());
    return new Promise((resolve) => this.pending.push(() => resolve(make())));
  }

  /** 멈춰 있던 연결 시도를 모두 끝낸다 */
  release(): void {
    for (const done of this.pending.splice(0)) done();
  }
}

const info = (overrides: Partial<TargetConnectInfo> = {}): TargetConnectInfo => ({
  kind: 'oracle',
  host: 'db.local',
  port: 1521,
  username: 'quartz',
  password: 'secret',
  oracleServiceName: 'FREEPDB1',
  ...overrides,
});

const target = (id: number, overrides: Partial<TargetConnectInfo> = {}): PoolTarget => ({
  id,
  info: info(overrides),
});

/** 바깥에서 끝낼 수 있는 Promise */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('TargetPoolManager', () => {
  let adapter: FakeAdapter;
  let manager: TargetPoolManager;

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = new FakeAdapter();
    manager = new TargetPoolManager([adapter]);
  });

  afterEach(async () => {
    await manager.closeAll();
    vi.useRealTimers();
  });

  it('처음 쓸 때 커넥션을 열고, 끝나면 유휴로 돌려놓아 다시 쓴다', async () => {
    expect(manager.stats(1)).toBeUndefined();
    const first = await manager.withConnection(target(1), (c) =>
      Promise.resolve((c as FakeConn).id),
    );
    const second = await manager.withConnection(target(1), (c) =>
      Promise.resolve((c as FakeConn).id),
    );
    expect(first).toBe(second);
    expect(adapter.opened).toHaveLength(1);
    expect(manager.stats(1)).toEqual({ idle: 1, inUse: 0, connecting: 0, waiting: 0 });
  });

  it('기본 제한값(연결 10초, 쿼리 10초)을 어댑터에 넘긴다', async () => {
    await manager.withConnection(target(1), () => Promise.resolve());
    expect(adapter.options[0]).toEqual({ connectTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
  });

  it('접속당 커넥션은 최대 2개이고, 세 번째 요청은 하나가 반납될 때까지 기다린다', async () => {
    const gates = [deferred(), deferred()];
    const running = gates.map((gate) => manager.withConnection(target(1), () => gate.promise));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.stats(1)).toMatchObject({ inUse: 2, waiting: 0 });

    let thirdDone = false;
    const third = manager
      .withConnection(target(1), (c) => Promise.resolve((c as FakeConn).id))
      .then((id) => {
        thirdDone = true;
        return id;
      });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(thirdDone).toBe(false);
    expect(manager.stats(1)).toMatchObject({ inUse: 2, waiting: 1 });

    gates[0]!.resolve();
    await expect(third).resolves.toBe(1);
    gates[1]!.resolve();
    await Promise.all(running);
    expect(adapter.opened).toHaveLength(2);
  });

  it('10초를 기다려도 커넥션이 나지 않으면 TARGET_BUSY로 실패한다', async () => {
    const gate = deferred();
    const running = [1, 2].map(() => manager.withConnection(target(1), () => gate.promise));
    await vi.advanceTimersByTimeAsync(0);

    const third = manager.withConnection(target(1), () => Promise.resolve('x'));
    const assertion = expect(third).rejects.toMatchObject({ code: 'TARGET_BUSY', retryable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(manager.stats(1)).toMatchObject({ waiting: 0 });

    gate.resolve();
    await Promise.all(running);
  });

  it('유휴 60초가 지나면 커넥션을 닫는다', async () => {
    let conn: FakeConn | undefined;
    await manager.withConnection(target(1), (c) => {
      conn = c as FakeConn;
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(conn!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(conn!.closed).toBe(true);
    expect(manager.stats(1)).toMatchObject({ idle: 0 });

    // 다음 요청은 새 커넥션을 연다
    await manager.withConnection(target(1), () => Promise.resolve());
    expect(adapter.opened).toHaveLength(2);
  });

  it('다시 쓰면 유휴 시간을 처음부터 센다', async () => {
    await manager.withConnection(target(1), () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(50_000);
    await manager.withConnection(target(1), () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(50_000);
    expect(adapter.opened[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(adapter.opened[0]!.closed).toBe(true);
  });

  it('연결이 10초 안에 끝나지 않으면 TARGET_TIMEOUT. 늦게 끝난 커넥션은 닫고, 그때까지 자리를 비우지 않는다', async () => {
    adapter.hang = true;
    const attempts = [1, 2].map(() => manager.withConnection(target(1), () => Promise.resolve()));
    const assertions = attempts.map((p) =>
      expect(p).rejects.toMatchObject({ code: 'TARGET_TIMEOUT' }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(assertions);

    // 드라이버의 연결 시도는 아직 진행 중이므로 새 요청은 소켓을 더 열지 않고 기다린다
    expect(manager.stats(1)).toMatchObject({ connecting: 2 });
    adapter.hang = false;
    const next = manager.withConnection(target(1), (c) => Promise.resolve((c as FakeConn).id));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.stats(1)).toMatchObject({ waiting: 1 });

    adapter.release();
    await expect(next).resolves.toBe(3);
    expect(adapter.opened.slice(0, 2).every((c) => c.closed)).toBe(true);
  });

  it('응답하지 않는 접속이 있어도 다른 접속의 요청은 기다리지 않는다 (NFR-REL-01)', async () => {
    const hung = new FakeAdapter();
    hung.hang = true;
    const healthy = new FakeAdapter();
    // 종류별 어댑터는 하나뿐이므로 접속 ID로 나눠 같은 어댑터를 쓰는 상황을 흉내 낸다
    const routing: DriverAdapter = {
      kind: 'oracle',
      connect: (i, o) => (i.host === 'hung' ? hung : healthy).connect(i, o),
    };
    const m = new TargetPoolManager([routing]);
    const slow = m.withConnection(target(1, { host: 'hung' }), () => Promise.resolve());
    const slowAssertion = expect(slow).rejects.toMatchObject({ code: 'TARGET_TIMEOUT' });

    await expect(m.withConnection(target(2), () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(m.stats(1)).toMatchObject({ connecting: 1 });

    await vi.advanceTimersByTimeAsync(10_000);
    await slowAssertion;
    hung.release();
    await m.closeAll();
  });

  it('커넥션이 끊긴 오류(TARGET_UNREACHABLE, TARGET_TIMEOUT)면 풀에 돌려놓지 않는다', async () => {
    await expect(
      manager.withConnection(target(1), () =>
        Promise.reject(new TargetError('TARGET_UNREACHABLE')),
      ),
    ).rejects.toBeInstanceOf(TargetError);
    expect(adapter.opened[0]!.closed).toBe(true);
    expect(manager.stats(1)).toMatchObject({ idle: 0, inUse: 0 });
  });

  it('그 밖의 오류는 커넥션을 다시 쓴다', async () => {
    await expect(
      manager.withConnection(target(1), () => Promise.reject(new TargetError('TARGET_ERROR'))),
    ).rejects.toMatchObject({ code: 'TARGET_ERROR' });
    await expect(
      manager.withConnection(target(1), () => Promise.reject(new Error('bug'))),
    ).rejects.toThrow('bug');
    expect(adapter.opened).toHaveLength(1);
    expect(manager.stats(1)).toMatchObject({ idle: 1 });
  });

  it('커밋하지 않은 트랜잭션이 남아 있으면 롤백하고 돌려놓는다', async () => {
    await manager.withConnection(target(1), async (c) => {
      await c.execute('UPDATE x SET y = 1');
    });
    expect(adapter.opened[0]!.rolledBack).toBe(1);
    expect(adapter.opened[0]!.closed).toBe(false);
  });

  it('접속 정보가 바뀌면 이전 풀을 버리고 새로 만든다', async () => {
    await manager.withConnection(target(1), () => Promise.resolve());
    await manager.withConnection(target(1, { password: 'changed' }), () => Promise.resolve());
    expect(adapter.opened).toHaveLength(2);
    expect(adapter.opened[0]!.closed).toBe(true);
    expect(manager.stats(1)).toMatchObject({ idle: 1 });
  });

  it('invalidate는 유휴 커넥션을 닫고, 사용 중인 커넥션은 반납될 때 닫는다', async () => {
    const gate = deferred();
    const running = manager.withConnection(target(1), () => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    await manager.invalidate(1);
    expect(manager.stats(1)).toBeUndefined();
    expect(adapter.opened[0]!.closed).toBe(false);
    gate.resolve();
    await running;
    expect(adapter.opened[0]!.closed).toBe(true);
  });

  it('지원하지 않는 DB 종류는 TARGET_ERROR', async () => {
    await expect(
      manager.withConnection(target(1, { kind: 'mysql' }), () => Promise.resolve()),
    ).rejects.toMatchObject({ code: 'TARGET_ERROR' });
  });

  it('연결 실패는 어댑터가 던진 오류를 그대로 전달하고 자리를 비운다', async () => {
    adapter.failWith = new TargetError('TARGET_AUTH_FAILED');
    await expect(manager.withConnection(target(1), () => Promise.resolve())).rejects.toMatchObject({
      code: 'TARGET_AUTH_FAILED',
    });
    expect(manager.stats(1)).toEqual({ idle: 0, inUse: 0, connecting: 0, waiting: 0 });
  });
});
