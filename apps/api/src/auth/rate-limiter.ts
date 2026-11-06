/**
 * 키(IP)별 고정 창 요청 제한. 단일 프로세스(NFR-REL-04)이므로 메모리에 둔다.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** 이 수를 넘으면 지난 창을 정리한다 */
    private readonly sweepThreshold = 10_000,
  ) {}

  /** 허용하면 null, 넘었으면 다시 시도할 수 있을 때까지 남은 초 */
  hit(key: string, now: number): number | null {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.sweepThreshold) this.sweep(now);
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= this.limit) return null;
    return Math.max(1, Math.ceil((w.resetAt - now) / 1000));
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
  }
}
