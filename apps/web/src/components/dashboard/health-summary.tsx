import type { SchedulerHealth, SchedulerSummaryDto } from '@qa/shared';
import { LayersIcon } from 'lucide-react';

import { SCHEDULER_HEALTH_META, TONE_CLASSES } from '@/components/status/tones';

const HEALTHS: SchedulerHealth[] = ['critical', 'unreachable', 'warning', 'ok'];

/** 손봐야 하는 상태. 0보다 크면 톤 색으로 강조하고, 0이면 조용히 둔다 */
const ATTENTION: SchedulerHealth[] = ['critical', 'unreachable', 'warning'];

function Tile({
  label,
  count,
  icon: Icon,
  iconClass,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  iconClass: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card p-3 text-left sm:p-4 shadow-xs transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary"
    >
      <span
        className={`hidden size-9 shrink-0 items-center justify-center rounded-lg sm:flex ${iconClass}`}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex flex-col">
        <span className="text-2xl leading-none font-semibold tabular-nums">{count}</span>
        <span className="mt-1 text-sm text-muted-foreground">{label}</span>
      </span>
    </button>
  );
}

/**
 * 대시보드 맨 위 요약 띠(B-38 대시보드 구성). 상태별 스케줄러 수를 보여 주고, 누르면 그 상태만 거른다.
 * 거르기는 화면에서만 한다(서버 필터와 함께 쓰인다).
 */
export function HealthSummary({
  items,
  value,
  onChange,
}: {
  items: SchedulerSummaryDto[];
  value: SchedulerHealth | undefined;
  onChange: (next: SchedulerHealth | undefined) => void;
}) {
  const count = (h: SchedulerHealth) => items.filter((i) => i.snapshot?.status === h).length;
  return (
    <div
      role="group"
      aria-label="상태별 스케줄러 수"
      className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-5"
    >
      <Tile
        label="전체"
        count={items.length}
        icon={LayersIcon}
        iconClass={TONE_CLASSES.neutral.soft}
        pressed={value === undefined}
        onClick={() => onChange(undefined)}
      />
      {HEALTHS.map((h) => {
        const meta = SCHEDULER_HEALTH_META[h];
        const n = count(h);
        const quiet = ATTENTION.includes(h) && n === 0;
        return (
          <Tile
            key={h}
            label={meta.label}
            count={n}
            icon={meta.icon}
            iconClass={quiet ? TONE_CLASSES.neutral.soft : TONE_CLASSES[meta.tone].soft}
            pressed={value === h}
            onClick={() => onChange(value === h ? undefined : h)}
          />
        );
      })}
    </div>
  );
}
