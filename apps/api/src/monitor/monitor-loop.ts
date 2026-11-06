/**
 * 스케줄러별 감시 시점을 관리한다 (TRD §9.1). 대상 DB나 메타 저장소를 모르는 순수한 스케줄러다.
 *
 * - 스케줄러마다 타이머가 따로 있다. 다음 회차는 **계획 시각 + 주기**로 정하고 회차를 시작할 때 미리 잡아 둔다.
 *   한 스케줄러의 감시가 느려도 자기 다음 회차만 건너뛸 뿐 다른 스케줄러의 시점은 밀리지 않는다.
 * - 동시에 도는 회차는 `concurrency`개까지다. 넘으면 대기열에서 기다린다.
 * - 같은 스케줄러의 회차는 겹치지 않는다. 이전 회차가 아직 돌고 있으면 이번 회차를 건너뛴다.
 * - `run`은 실패해도 던지지 않아야 한다(실패 기록은 호출자 책임). 던지면 그 회차를 끝난 것으로 본다.
 */
export interface MonitorLoopOptions {
  concurrency: number;
  run: (schedulerId: number) => Promise<void>;
  /** 테스트용 */
  now?: () => number;
  random?: () => number;
  /** 첫 회차 지터 상한(ms). 주기보다 짧으면 주기를 쓴다. 기본 15초 */
  maxInitialJitterMs?: number;
}

interface Entry {
  intervalMs: number;
  nextAt: number;
  timer: NodeJS.Timeout | undefined;
  running: boolean;
  queued: boolean;
}

export interface LoopStats {
  scheduled: number;
  running: number;
  queued: number;
  /** 이전 회차가 끝나지 않아 건너뛴 횟수 */
  skipped: number;
}

export class MonitorLoop {
  private readonly entries = new Map<number, Entry>();
  private readonly queue: number[] = [];
  private active = 0;
  private skipped = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxJitter: number;

  constructor(private readonly opts: MonitorLoopOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.maxJitter = opts.maxInitialJitterMs ?? 15_000;
  }

  /**
   * 스케줄러를 등록하거나 주기를 바꾼다.
   * - 새 스케줄러: `immediate`면 바로, 아니면 지터를 준 시각에 첫 회차를 돈다(재시작 시 분산)
   * - 이미 있으면: 남은 시간이 새 주기보다 길 때만 다음 회차를 앞당긴다. `immediate`면 바로 돈다
   */
  upsert(schedulerId: number, intervalMs: number, options: { immediate?: boolean } = {}): void {
    if (this.stopped) return;
    const now = this.now();
    const existing = this.entries.get(schedulerId);
    if (existing) {
      existing.intervalMs = intervalMs;
      const nextAt = options.immediate ? now : Math.min(existing.nextAt, now + intervalMs);
      this.schedule(schedulerId, existing, nextAt);
      return;
    }
    const entry: Entry = {
      intervalMs,
      nextAt: now,
      timer: undefined,
      running: false,
      queued: false,
    };
    this.entries.set(schedulerId, entry);
    const jitter = options.immediate
      ? 0
      : Math.floor(this.random() * Math.min(intervalMs, this.maxJitter));
    this.schedule(schedulerId, entry, now + jitter);
  }

  remove(schedulerId: number): void {
    const entry = this.entries.get(schedulerId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(schedulerId);
    const i = this.queue.indexOf(schedulerId);
    if (i >= 0) this.queue.splice(i, 1);
  }

  has(schedulerId: number): boolean {
    return this.entries.has(schedulerId);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    this.queue.length = 0;
  }

  get stats(): LoopStats {
    let running = 0;
    for (const e of this.entries.values()) if (e.running) running++;
    return {
      scheduled: this.entries.size,
      running,
      queued: this.queue.length,
      skipped: this.skipped,
    };
  }

  private schedule(id: number, entry: Entry, at: number): void {
    clearTimeout(entry.timer);
    entry.nextAt = at;
    entry.timer = setTimeout(() => this.due(id), Math.max(0, at - this.now()));
    // 감시 타이머 때문에 프로세스가 종료되지 못하는 일이 없게 한다
    entry.timer.unref();
  }

  /** 회차 시각이 됐다. 다음 회차를 먼저 잡고 대기열에 넣는다 */
  private due(id: number): void {
    const entry = this.entries.get(id);
    if (!entry || this.stopped) return;
    const planned = entry.nextAt;
    // 늦게 깨어났어도 계획 시각을 기준으로 다음 회차를 잡는다. 이미 지났으면 지금부터 센다
    this.schedule(id, entry, Math.max(planned + entry.intervalMs, this.now() + 1));
    if (entry.running || entry.queued) {
      this.skipped++;
      return;
    }
    entry.queued = true;
    this.queue.push(id);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.opts.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.queued = false;
      entry.running = true;
      this.active++;
      void this.opts
        .run(id)
        .catch(() => undefined)
        .finally(() => {
          entry.running = false;
          this.active--;
          this.drain();
        });
    }
  }
}
