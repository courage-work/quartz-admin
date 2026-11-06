'use client';

import {
  CLOCK_SKEW_WARN_MS,
  type DashboardQuery,
  type DashboardResponse,
  type SchedulerSummaryDto,
} from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ClockAlertIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  SearchIcon,
  UnplugIcon,
} from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { FormAlert } from '@/components/form/form-alert';
import { RefreshControls, useRefreshInterval } from '@/components/schedulers/refresh-controls';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge } from '@/components/status/environment';
import { SchedulerHealthBadge } from '@/components/status/status-badge';
import { TRIGGER_STATE_META } from '@/components/status/tones';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { DASHBOARD_KEY, formatAgo } from '@/lib/schedulers';

const ALL = 'all';

/** 카드에 보여 줄 트리거 상태와 순서. 나머지는 "그 밖"으로 묶는다 */
const CARD_STATES = ['WAITING', 'EXECUTING', 'ACQUIRED', 'PAUSED', 'BLOCKED', 'ERROR'] as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums" title={hint}>
        {value}
      </span>
    </div>
  );
}

function SchedulerCard({ item, now }: { item: SchedulerSummaryDto; now: number }) {
  const snap = item.snapshot;
  const nodes = snap?.nodes ?? null;
  const active = nodes?.filter((n) => n.active).length ?? null;
  const counts = snap?.triggerCounts ?? null;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  const skewWarn =
    snap?.clockSkewMs !== null &&
    snap?.clockSkewMs !== undefined &&
    Math.abs(snap.clockSkewMs) > CLOCK_SKEW_WARN_MS;
  const unreachable = snap?.status === 'unreachable';

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              href={`/scheduler?id=${item.id}`}
              className="underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground"
            >
              {item.displayName}
            </Link>
            {snap ? (
              <SchedulerHealthBadge health={snap.status} />
            ) : (
              <Badge variant="neutral">감시 전</Badge>
            )}
          </div>
        </CardTitle>
        <CardDescription>
          <span className="flex flex-wrap items-center gap-2">
            <EnvBadge environment={item.connection.envLabel} />
            <span>{item.connection.name}</span>
            {item.schedName !== item.displayName ? (
              <span className="font-mono">{item.schedName}</span>
            ) : null}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-4 gap-2">
            <Stat
              label="활성 노드"
              value={active === null ? '-' : `${active}/${nodes!.length}`}
              hint={`기대 노드 ${item.expectedNodeCount}개`}
            />
            <Stat label="트리거" value={total === null ? '-' : String(total)} />
            <Stat
              label="실행 중"
              value={snap?.executingCount === null || !snap ? '-' : String(snap.executingCount)}
            />
            <Stat label="열린 알림" value={String(item.openAlertCount)} />
          </div>
          {counts ? (
            <div className="flex flex-wrap gap-1">
              {CARD_STATES.filter((s) => (counts[s] ?? 0) > 0).map((s) => {
                const meta = TRIGGER_STATE_META[s];
                return (
                  <Badge key={s} variant={meta.tone} title={s}>
                    <meta.icon data-icon="inline-start" aria-hidden />
                    {meta.label} {counts[s]}
                  </Badge>
                );
              })}
            </div>
          ) : null}
          {unreachable ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <UnplugIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {snap.errorMessage} (연속 {snap.consecutiveFailures}회)
                {snap.dbNow !== null ? ` · 위 값은 ${formatDateTime(snap.dbNow)} 기준` : ''}
              </span>
            </p>
          ) : null}
          {skewWarn ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ClockAlertIcon className="size-4 shrink-0" aria-hidden />
              도구 서버와 DB의 시계가 {Math.round(Math.abs(snap.clockSkewMs!) / 1000)}초 차이 납니다
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {snap
              ? `마지막 감시 ${formatAgo(now - snap.polledAt)} · ${item.pollIntervalSec}초마다`
              : '첫 감시를 기다리는 중입니다'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Filters({
  data,
  value,
  onChange,
}: {
  data: DashboardResponse | undefined;
  value: DashboardQuery;
  onChange: (next: DashboardQuery) => void;
}) {
  const [q, setQ] = useState(value.q ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onChange({ ...value, q: q.trim() || undefined });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <Field className="w-40">
        <FieldLabel htmlFor="dash-env">환경</FieldLabel>
        <Select
          value={value.env ?? ALL}
          onValueChange={(v) => onChange({ ...value, env: v === ALL ? undefined : v })}
        >
          <SelectTrigger id="dash-env">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체</SelectItem>
            {data?.envs.map((env) => (
              <SelectItem key={env} value={env}>
                {env}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field className="w-40">
        <FieldLabel htmlFor="dash-tag">태그</FieldLabel>
        <Select
          value={value.tag ?? ALL}
          onValueChange={(v) => onChange({ ...value, tag: v === ALL ? undefined : v })}
        >
          <SelectTrigger id="dash-tag">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>전체</SelectItem>
            {data?.tags.map((tag) => (
              <SelectItem key={tag} value={tag}>
                {tag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field className="w-64">
        <FieldLabel htmlFor="dash-q">이름(스케줄러·접속)</FieldLabel>
        <Input id="dash-q" value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      <Button type="submit" variant="outline">
        <SearchIcon data-icon="inline-start" aria-hidden />
        검색하기
      </Button>
    </form>
  );
}

function NoSchedulers() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayoutDashboardIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>아직 등록한 스케줄러가 없습니다</EmptyTitle>
        <EmptyDescription>
          Quartz 테이블이 있는 DB 접속을 추가하면 스케줄러를 자동으로 찾아 등록할 수 있습니다.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href="/connections/new">
            <DatabaseIcon data-icon="inline-start" aria-hidden />
            접속 추가하기
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/**
 * 대시보드 (FR-VIEW-01). 감시 루프가 남긴 스냅샷만 읽으므로 연결할 수 없는 대상이 있어도
 * 바로 뜬다(NFR-PERF-01, FR-VIEW-07). 카드의 값은 각 스케줄러의 마지막 감시 기준이다.
 */
export function DashboardView() {
  const [filter, setFilter] = useState<DashboardQuery>({});
  const [refreshMs, setRefreshMs] = useRefreshInterval();
  const dashboard = useQuery({
    queryKey: [...DASHBOARD_KEY, filter],
    queryFn: ({ signal }) => api<DashboardResponse>('/schedulers', { query: filter, signal }),
    refetchInterval: refreshMs || false,
    placeholderData: (prev) => prev,
  });
  const filtered = filter.env !== undefined || filter.tag !== undefined || filter.q !== undefined;
  const now = dashboard.data?.generatedAt ?? 0;

  let body;
  if (dashboard.isError) body = <FormAlert message={dashboard.error.message} />;
  else if (dashboard.isPending)
    body = (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-56 w-full" />
        ))}
      </div>
    );
  else if (dashboard.data.items.length === 0 && !filtered) body = <NoSchedulers />;
  else if (dashboard.data.items.length === 0)
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>조건에 맞는 스케줄러가 없습니다</EmptyTitle>
          <EmptyDescription>환경, 태그, 이름 조건을 바꾸거나 모두 지우세요.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => setFilter({})}>
            필터 모두 지우기
          </Button>
        </EmptyContent>
      </Empty>
    );
  else
    body = (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {dashboard.data.items.map((item) => (
          <SchedulerCard key={item.id} item={item} now={now} />
        ))}
      </div>
    );

  return (
    <>
      <PageHeader
        title="대시보드"
        description="등록한 Quartz 스케줄러의 상태입니다. 각 카드는 마지막 감시 결과를 보여 줍니다."
        actions={
          <RefreshControls
            dataTime={dashboard.data?.generatedAt}
            dataTimeLabel="불러온 시각"
            refreshMs={refreshMs}
            onRefreshMsChange={setRefreshMs}
            onRefresh={() => void dashboard.refetch()}
            refreshing={dashboard.isFetching}
          />
        }
      />
      {/* 필터를 지우면 입력칸도 비우도록 다시 만든다 */}
      <Filters
        key={JSON.stringify(filter)}
        data={dashboard.data}
        value={filter}
        onChange={setFilter}
      />
      {body}
    </>
  );
}
