import type { BindValue, QueryOptions, Row, TargetConn } from '../../src/adapter.js';

/** 측정값 묶음(ms) */
export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** 가장 가까운 순위(nearest-rank) 백분위 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? Number.NaN,
    mean: sorted.length ? sum / sorted.length : Number.NaN,
  };
}

export function ms(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

/** 쿼리 왕복 수와 시간을 세는 커넥션. 제품 어댑터의 커넥션을 감싼다 */
export interface CountingConn extends TargetConn {
  readonly calls: number;
  /** reset 뒤 실행한 문장과 걸린 시간(ms) */
  readonly log: readonly { sql: string; ms: number }[];
  reset(): void;
}

export function countingConn(inner: TargetConn): CountingConn {
  let log: { sql: string; ms: number }[] = [];
  const track = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await run();
    } finally {
      log.push({ sql, ms: performance.now() - start });
    }
  };
  return {
    get kind() {
      return inner.kind;
    },
    get inTransaction() {
      return inner.inTransaction;
    },
    get calls() {
      return log.length;
    },
    get log() {
      return log;
    },
    reset() {
      log = [];
    },
    query<R extends Row = Row>(sql: string, binds?: readonly BindValue[], options?: QueryOptions) {
      return track(sql, () => inner.query<R>(sql, binds, options));
    },
    execute(sql: string, binds?: readonly BindValue[], options?: QueryOptions) {
      return track(sql, () => inner.execute(sql, binds, options));
    },
    commit: () => inner.commit(),
    rollback: () => inner.rollback(),
    close: () => inner.close(),
  };
}

/** 마크다운 표 */
export function table(head: readonly string[], rows: readonly (readonly (string | number)[])[]) {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** 목표를 넘은 항목. 측정은 끝까지 하고 마지막에 한꺼번에 실패시킨다 */
export class Verdicts {
  private readonly items: { name: string; ok: boolean; detail: string }[] = [];

  check(name: string, ok: boolean, detail: string): void {
    this.items.push({ name, ok, detail });
  }

  get failures() {
    return this.items.filter((i) => !i.ok);
  }

  render(): string {
    return table(
      ['항목', '결과', '값'],
      this.items.map((i) => [i.name, i.ok ? '통과' : '**미달**', i.detail]),
    );
  }
}
