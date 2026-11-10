import type { SchedulerDetailDto, SnapshotDto } from '@qa/shared';
import {
  ActivityIcon,
  ListChecksIcon,
  type LucideIcon,
  ServerIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { TriggerDistribution, TriggerLegend } from '@/components/dashboard/trigger-distribution';
import { type Tone, TONE_CLASSES } from '@/components/status/tones';

function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  stale,
  aside,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  /** 손볼 때만 톤을 준다. 평소에는 neutral로 조용히 둔다 */
  tone: Tone;
  /** 지금 값이 아니라 마지막으로 읽은 값이다. 옅게 보인다 */
  stale?: boolean;
  /** 숫자 옆에 두는 것(분포 범례). 좁으면 숫자 아래로 내려간다 */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span
          className={`flex size-7 items-center justify-center rounded-md ${TONE_CLASSES[tone].soft}`}
        >
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-2">
          <span
            className={`text-2xl leading-none font-semibold tabular-nums ${stale ? 'text-muted-foreground' : ''}`}
          >
            {value}
          </span>
          {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** 지표 띠가 읽는 값만 고른 모양. `SchedulerDetailDto`를 그대로 넘길 수 있다 */
export type SchedulerStatsInput = Pick<SchedulerDetailDto, 'expectedNodeCount'> & {
  snapshot: Pick<SnapshotDto, 'nodes' | 'triggerCounts' | 'executingCount'> | null;
};

/**
 * 스케줄러 상세 맨 위 지표 띠. 마지막 감시 스냅샷 기준이다.
 * `stale`: 대상 DB에 연결하지 못해 마지막으로 읽은 값을 보여 주는 중이다. 값을 옅게 하고 톤 강조를 뺀다
 */
export function SchedulerStats({ s, stale = false }: { s: SchedulerStatsInput; stale?: boolean }) {
  const snap = s.snapshot;
  const nodes = snap?.nodes ?? null;
  const active = nodes?.filter((n) => n.active).length ?? null;
  const counts = snap?.triggerCounts ?? null;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  const attention = counts
    ? (counts.ERROR ?? 0) + (counts.BLOCKED ?? 0) + (counts.PAUSED_BLOCKED ?? 0)
    : null;
  const nodeShort = active !== null && active < s.expectedNodeCount;

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatTile
        label="활성 노드"
        value={active === null ? '-' : `${active}/${nodes!.length}`}
        sub={`기대 ${s.expectedNodeCount}`}
        icon={ServerIcon}
        tone={nodeShort && !stale ? 'warning' : 'neutral'}
        stale={stale}
      />
      <StatTile
        label="트리거"
        value={total === null ? '-' : String(total)}
        icon={ListChecksIcon}
        tone="neutral"
        stale={stale}
        aside={counts ? <TriggerLegend counts={counts} /> : null}
      >
        {counts ? (
          <div className={stale ? 'opacity-50' : undefined}>
            <TriggerDistribution counts={counts} />
          </div>
        ) : null}
      </StatTile>
      <StatTile
        label="실행 중"
        value={snap?.executingCount == null ? '-' : String(snap.executingCount)}
        icon={ActivityIcon}
        tone={snap?.executingCount && !stale ? 'info' : 'neutral'}
        stale={stale}
      />
      <StatTile
        label="오류·차단"
        value={attention === null ? '-' : String(attention)}
        icon={TriangleAlertIcon}
        tone={stale ? 'neutral' : counts?.ERROR ? 'destructive' : attention ? 'warning' : 'neutral'}
        stale={stale}
      />
    </div>
  );
}
