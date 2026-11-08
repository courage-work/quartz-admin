import type { SchedulerDetailDto, SnapshotDto } from '@qa/shared';
import {
  ActivityIcon,
  ListChecksIcon,
  type LucideIcon,
  ServerIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { TriggerDistribution } from '@/components/dashboard/trigger-distribution';
import { type Tone, TONE_CLASSES } from '@/components/status/tones';

function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  /** 손볼 때만 톤을 준다. 평소에는 neutral로 조용히 둔다 */
  tone: Tone;
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
      <div className="flex items-baseline gap-2">
        <span className="text-2xl leading-none font-semibold tabular-nums">{value}</span>
        {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** 지표 띠가 읽는 값만 고른 모양. `SchedulerDetailDto`를 그대로 넘길 수 있다 */
export type SchedulerStatsInput = Pick<SchedulerDetailDto, 'expectedNodeCount'> & {
  snapshot: Pick<SnapshotDto, 'nodes' | 'triggerCounts' | 'executingCount'> | null;
};

/** 스케줄러 상세 맨 위 지표 띠. 마지막 감시 스냅샷 기준이다 */
export function SchedulerStats({ s }: { s: SchedulerStatsInput }) {
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
        tone={nodeShort ? 'warning' : 'neutral'}
      />
      <StatTile
        label="트리거"
        value={total === null ? '-' : String(total)}
        icon={ListChecksIcon}
        tone="neutral"
      >
        {counts ? <TriggerDistribution counts={counts} /> : null}
      </StatTile>
      <StatTile
        label="실행 중"
        value={snap?.executingCount == null ? '-' : String(snap.executingCount)}
        icon={ActivityIcon}
        tone={snap?.executingCount ? 'info' : 'neutral'}
      />
      <StatTile
        label="오류·차단"
        value={attention === null ? '-' : String(attention)}
        icon={TriangleAlertIcon}
        tone={counts?.ERROR ? 'destructive' : attention ? 'warning' : 'neutral'}
      />
    </div>
  );
}
