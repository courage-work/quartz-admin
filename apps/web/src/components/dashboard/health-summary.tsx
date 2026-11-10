import type { SchedulerHealth, SchedulerSummaryDto } from '@qa/shared';
import { LayersIcon, type LucideIcon } from 'lucide-react';

import { SCHEDULER_HEALTH_META, type Tone, TONE_CLASSES } from '@/components/status/tones';

const HEALTHS: SchedulerHealth[] = ['critical', 'unreachable', 'warning', 'ok'];

/** 손봐야 하는 상태. 0보다 크면 톤 색으로 강조하고, 0이면 조용히 둔다 */
const ATTENTION: SchedulerHealth[] = ['critical', 'unreachable', 'warning'];

export type HealthCounts = Partial<Record<SchedulerHealth, number>>;

/** 스냅샷 상태별 스케줄러 수. 감시 전(스냅샷 없음)은 어느 상태에도 세지 않는다 */
export function countByHealth(items: SchedulerSummaryDto[]): HealthCounts {
  const counts: HealthCounts = {};
  for (const i of items) {
    if (i.snapshot) counts[i.snapshot.status] = (counts[i.snapshot.status] ?? 0) + 1;
  }
  return counts;
}

function Tile({
  label,
  count,
  icon: Icon,
  tone,
  pressed,
  onClick,
  wide,
}: {
  label: string;
  count: number;
  icon: LucideIcon;
  tone: Tone;
  pressed: boolean;
  onClick: () => void;
  /** 둘째 줄 타일(두 개가 한 줄을 반씩). 넓은 화면에서는 다섯 개가 한 줄이라 차이가 없다 */
  wide: boolean;
}) {
  const classes = TONE_CLASSES[tone];
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary md:p-4 xl:col-span-1 ${wide ? 'col-span-3' : 'col-span-2'}`}
    >
      {/* 넓은 화면: 톤 바탕 아이콘. 좁은 화면에서는 공간을 아끼려고 라벨 옆 작은 아이콘으로 바꾼다 */}
      <span
        className={`hidden size-9 shrink-0 items-center justify-center rounded-lg md:flex ${classes.soft}`}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex flex-col">
        <span className="text-2xl leading-none font-semibold tabular-nums">{count}</span>
        <span className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
          <Icon className={`size-3.5 shrink-0 md:hidden ${classes.text}`} aria-hidden />
          {label}
        </span>
      </span>
    </button>
  );
}

/**
 * 대시보드 맨 위 요약 띠(B-39). 상태별 스케줄러 수를 보여 주고, 누르면 그 상태만 거른다.
 * 거르기는 화면에서만 한다(서버 필터와 함께 쓰인다).
 */
export function HealthSummary({
  total,
  counts,
  value,
  onChange,
}: {
  total: number;
  counts: HealthCounts;
  value: SchedulerHealth | undefined;
  onChange: (next: SchedulerHealth | undefined) => void;
}) {
  return (
    <div
      role="group"
      aria-label="상태별 스케줄러 수"
      // 좁은 화면은 6칸 격자: 첫 줄 셋(2칸씩), 둘째 줄 둘(3칸씩). 3칸 격자면 둘째 줄에 빈칸이 남는다
      className="grid grid-cols-6 gap-2 md:gap-3 xl:grid-cols-5"
    >
      <Tile
        label="전체"
        count={total}
        icon={LayersIcon}
        tone="neutral"
        pressed={value === undefined}
        onClick={() => onChange(undefined)}
        wide={false}
      />
      {HEALTHS.map((h, i) => {
        const meta = SCHEDULER_HEALTH_META[h];
        const n = counts[h] ?? 0;
        const quiet = ATTENTION.includes(h) && n === 0;
        return (
          <Tile
            key={h}
            label={meta.label}
            count={n}
            icon={meta.icon}
            tone={quiet ? 'neutral' : meta.tone}
            pressed={value === h}
            onClick={() => onChange(value === h ? undefined : h)}
            wide={i >= 2}
          />
        );
      })}
    </div>
  );
}
