import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveHealth } from './health.js';
import { MonitorLoop } from './monitor-loop.js';

/** 바깥에서 끝낼 수 있는 Promise */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('MonitorLoop', () => {
  let starts: { id: number; at: number }[];
  let hang: Map<number, { promise: Promise<void>; resolve: () => void }>;

  const make = (concurrency = 8, random = () => 0) =>
    new MonitorLoop({
      concurrency,
      random,
      run: (id) => {
        starts.push({ id, at: Date.now() });
        return hang.get(id)?.promise ?? Promise.resolve();
      },
    });

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    starts = [];
    hang = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const startsOf = (id: number) => starts.filter((s) => s.id === id).map((s) => s.at);

  it('첫 회차는 지터만큼 늦추고(최대 15초), 이후 계획 시각 + 주기로 돈다', async () => {
    const loop = make(8, () => 0.5);
    loop.upsert(1, 60_000);
    await vi.advanceTimersByTimeAsync(7_499);
    expect(startsOf(1)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(startsOf(1)).toEqual([7_500, 67_500, 127_500]);
    loop.stop();
  });

  it('연결할 수 없는 스케줄러의 회차가 오래 걸려도 다른 스케줄러의 감시 시점은 밀리지 않는다', async () => {
    const loop = make();
    const stuck = deferred();
    hang.set(1, stuck);
    loop.upsert(1, 60_000);
    loop.upsert(2, 60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    // 1번은 첫 회차가 끝나지 않아 다음 회차를 건너뛰고, 2번은 제시간에 돈다
    expect(startsOf(1)).toEqual([0]);
    expect(startsOf(2)).toEqual([0, 60_000, 120_000, 180_000]);
    expect(loop.stats.skipped).toBe(3);

    // 1번 회차가 끝나면 원래 시점(240초)에 다시 돈다
    stuck.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startsOf(1)).toEqual([0, 240_000]);
    expect(startsOf(2).at(-1)).toBe(240_000);
    loop.stop();
  });

  it('동시 실행 수를 넘는 회차는 대기열에서 기다렸다가 자리가 나면 돈다', async () => {
    const loop = make(2);
    const gates = [deferred(), deferred()];
    hang.set(1, gates[0]!);
    hang.set(2, gates[1]!);
    for (const id of [1, 2, 3]) loop.upsert(id, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts.map((s) => s.id)).toEqual([1, 2]);
    expect(loop.stats).toMatchObject({ running: 2, queued: 1 });
    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts.map((s) => s.id)).toEqual([1, 2, 3]);
    gates[1]!.resolve();
    loop.stop();
  });

  it('immediate면 바로 돌고, 주기를 줄이면 다음 회차를 앞당긴다', async () => {
    const loop = make(8, () => 0.9);
    loop.upsert(1, 60_000, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(startsOf(1)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(10_000);
    loop.upsert(1, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(startsOf(1)).toEqual([0, 25_000]);
    loop.upsert(1, 15_000, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(startsOf(1)).toEqual([0, 25_000, 25_000]);
    loop.stop();
  });

  it('제거하면 더 이상 돌지 않고, run이 던져도 다음 회차는 돈다', async () => {
    const loop = new MonitorLoop({
      concurrency: 8,
      random: () => 0,
      run: (id) => {
        starts.push({ id, at: Date.now() });
        return Promise.reject(new Error('boom'));
      },
    });
    loop.upsert(1, 60_000);
    loop.upsert(2, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startsOf(1)).toEqual([0, 60_000]);
    loop.remove(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startsOf(1)).toEqual([0, 60_000]);
    expect(startsOf(2)).toEqual([0, 60_000, 120_000]);
    expect(loop.has(1)).toBe(false);
    loop.stop();
  });
});

describe('deriveHealth', () => {
  const node = (active: boolean) => ({
    instanceName: 'n',
    lastCheckinTime: 0,
    checkinInterval: 7_500,
    active,
    sinceCheckinMs: 0,
  });
  const base = { nodes: [node(true), node(true)], overdueCount: 0, triggerCounts: { WAITING: 3 } };

  it('활성 노드가 없거나 ERROR 트리거가 있으면 critical', () => {
    expect(deriveHealth({ ...base, nodes: [node(false)] }, { expectedNodeCount: 1 }, 0)).toBe(
      'critical',
    );
    expect(
      deriveHealth({ ...base, triggerCounts: { ERROR: 1 } }, { expectedNodeCount: 2 }, 0),
    ).toBe('critical');
  });

  it('노드 부족, 연체, 시계 차이 30초 초과는 warning', () => {
    expect(deriveHealth(base, { expectedNodeCount: 3 }, 0)).toBe('warning');
    expect(deriveHealth({ ...base, overdueCount: 2 }, { expectedNodeCount: 2 }, 0)).toBe('warning');
    expect(deriveHealth(base, { expectedNodeCount: 2 }, -30_001)).toBe('warning');
    expect(deriveHealth(base, { expectedNodeCount: 2 }, 30_000)).toBe('ok');
  });
});
