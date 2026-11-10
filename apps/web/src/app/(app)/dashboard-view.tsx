'use client';

import {
  CLOCK_SKEW_WARN_MS,
  type DashboardQuery,
  type DashboardResponse,
  SCHEDULER_HEALTH,
  type SchedulerHealth,
  type SchedulerSummaryDto,
} from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRightIcon,
  ClockAlertIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  SearchIcon,
  UnplugIcon,
} from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useRef, useState } from 'react';

import { countByHealth, HealthSummary } from '@/components/dashboard/health-summary';
import { TriggerDistribution } from '@/components/dashboard/trigger-distribution';
import { FormAlert } from '@/components/form/form-alert';
import { RefreshControls, useRefreshInterval } from '@/components/schedulers/refresh-controls';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge } from '@/components/status/environment';
import { SchedulerHealthBadge } from '@/components/status/status-badge';
import {
  HEALTH_ORDER,
  SCHEDULER_HEALTH_META,
  TONE_CLASSES,
  TRIGGER_STATE_META,
} from '@/components/status/tones';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useSlashFocus } from '@/hooks/use-slash-focus';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { DASHBOARD_KEY, formatAgo } from '@/lib/schedulers';
import { setParam, type UrlCodec, useUrlState } from '@/lib/use-url-state';

const ALL = 'all';

/** 카드에 보여 줄 트리거 상태와 순서 */
const CARD_STATES = ['WAITING', 'EXECUTING', 'ACQUIRED', 'PAUSED', 'BLOCKED', 'ERROR'] as const;

function Stat({
  label,
  value,
  hint,
  stale,
}: {
  label: string;
  value: string;
  hint?: string;
  /** 지금 값이 아니라 마지막으로 읽은 값이다. 옅게 보인다 */
  stale?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-3 first:pl-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-xl leading-none font-semibold tabular-nums ${stale ? 'text-muted-foreground' : ''}`}
        title={hint}
      >
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
  const tone = snap ? SCHEDULER_HEALTH_META[snap.status].tone : 'neutral';

  return (
    // 카드 전체가 스케줄러 상세로 가는 링크다(B-40). 올리면 테두리·그림자·제목 색이 바뀐다
    <Card interactive>
      {/* 상태 띠: 카드 묶음에서 손볼 카드를 먼저 눈에 띄게 한다. 의미는 배지가 글자로 전한다 */}
      <div aria-hidden className={`absolute inset-x-0 top-0 h-1 ${TONE_CLASSES[tone].rail}`} />
      <CardHeader>
        <CardTitle>
          <div className="flex items-start justify-between gap-2">
            <Link
              href={`/scheduler?id=${item.id}`}
              data-card-link
              className="inline-flex min-w-0 items-center gap-1 text-lg leading-tight font-semibold transition-colors outline-none group-hover/card:text-link after:absolute after:inset-0"
            >
              <span className="min-w-0 wrap-break-word">{item.displayName}</span>
              <ChevronRightIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition duration-150 ease-out group-hover/card:translate-x-0.5 group-hover/card:text-link"
              />
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
              <span className="font-mono text-xs">{item.schedName}</span>
            ) : null}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {/* 연결하지 못하면 문제를 먼저 알리고, 그 아래 값은 마지막으로 읽은 값임을 밝힌다 */}
          {unreachable ? (
            <Alert variant="warning">
              <UnplugIcon aria-hidden />
              <AlertTitle>
                대상 DB에 연결하지 못했습니다 (연속 {snap.consecutiveFailures}회)
              </AlertTitle>
              <AlertDescription>
                {/* 서버 메시지는 마침표 없이 끝나기도 해서 기준 시각은 줄을 바꿔 쓴다 */}
                <span className="block">{snap.errorMessage}</span>
                {snap.dbNow !== null ? (
                  <span className="block">
                    아래 값은 마지막으로 읽은 {formatDateTime(snap.dbNow)} 기준입니다.
                  </span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="grid grid-cols-4 divide-x divide-border">
            <Stat
              label="활성 노드"
              value={active === null ? '-' : `${active}/${nodes!.length}`}
              hint={`기대 노드 ${item.expectedNodeCount}개`}
              stale={unreachable}
            />
            <Stat label="트리거" value={total === null ? '-' : String(total)} stale={unreachable} />
            <Stat
              label="실행 중"
              value={snap?.executingCount === null || !snap ? '-' : String(snap.executingCount)}
              stale={unreachable}
            />
            <Stat label="열린 알림" value={String(item.openAlertCount)} />
          </div>
          {counts ? (
            <div className="flex flex-col gap-2">
              <div className={unreachable ? 'opacity-50' : undefined}>
                <TriggerDistribution counts={counts} />
              </div>
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
            </div>
          ) : null}
          {skewWarn ? (
            <Alert variant="warning">
              <ClockAlertIcon aria-hidden />
              <AlertDescription>
                도구 서버와 DB의 시계가 {Math.round(Math.abs(snap.clockSkewMs!) / 1000)}초 차이
                납니다
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </CardContent>
      <div className="mt-auto border-t border-border px-6 pt-4">
        <p className="text-xs text-muted-foreground">
          {snap
            ? `마지막 감시 ${formatAgo(now - snap.polledAt)} · ${item.pollIntervalSec}초마다`
            : '첫 감시를 기다리는 중입니다'}
        </p>
      </div>
    </Card>
  );
}

/** 손볼 상태가 먼저, 같은 상태끼리는 이름순 */
function bySeverity(a: SchedulerSummaryDto, b: SchedulerSummaryDto): number {
  const rank = (i: SchedulerSummaryDto) => (i.snapshot ? HEALTH_ORDER[i.snapshot.status] : 9);
  return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, 'ko');
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
  const qRef = useRef<HTMLInputElement>(null);
  useSlashFocus(qRef);
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
            <SelectGroup>
              <SelectItem value={ALL}>전체</SelectItem>
              {data?.envs.map((env) => (
                <SelectItem key={env} value={env}>
                  {env}
                </SelectItem>
              ))}
            </SelectGroup>
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
            <SelectGroup>
              <SelectItem value={ALL}>전체</SelectItem>
              {data?.tags.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field className="w-64">
        <FieldLabel htmlFor="dash-q">검색(스케줄러·접속 이름)</FieldLabel>
        <Input
          ref={qRef}
          id="dash-q"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-keyshortcuts="/"
        />
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

type DashboardView = DashboardQuery & { health?: SchedulerHealth };

/** 필터·요약 띠 선택 ↔ 주소(`env`, `tag`, `q`, `health`). 스케줄러 상세에 갔다 돌아와도 그대로다(B-40) */
const DASHBOARD_CODEC: UrlCodec<DashboardView> = {
  parse: (p) => {
    const health = p.get('health');
    return {
      env: p.get('env') || undefined,
      tag: p.get('tag') || undefined,
      q: p.get('q') || undefined,
      health: SCHEDULER_HEALTH.find((h) => h === health),
    };
  },
  write: (v, p) => {
    setParam(p, 'env', v.env);
    setParam(p, 'tag', v.tag);
    setParam(p, 'q', v.q);
    setParam(p, 'health', v.health);
  },
};

/**
 * 대시보드 (FR-VIEW-01). 감시 루프가 남긴 스냅샷만 읽으므로 연결할 수 없는 대상이 있어도
 * 바로 뜬다(NFR-PERF-01, FR-VIEW-07). 카드의 값은 각 스케줄러의 마지막 감시 기준이다.
 */
export function DashboardView() {
  const [view, setView] = useUrlState(DASHBOARD_CODEC);
  const { health, ...filter } = view;
  const setFilter = (f: DashboardQuery) => setView((v) => ({ ...f, health: v.health }));
  const setHealth = (h: SchedulerHealth | undefined) => setView((v) => ({ ...v, health: h }));
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
  if (dashboard.isError) body = <FormAlert error={dashboard.error} />;
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
  else {
    const items = dashboard.data.items
      .filter((i) => health === undefined || i.snapshot?.status === health)
      .sort(bySeverity);
    body = (
      <>
        {items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>이 상태인 스케줄러가 없습니다</EmptyTitle>
              <EmptyDescription>위 요약에서 다른 상태를 고르거나 전체를 보세요.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => setHealth(undefined)}>
                전체 보기
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <SchedulerCard key={item.id} item={item} now={now} />
            ))}
          </div>
        )}
      </>
    );
  }

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
      {dashboard.data && dashboard.data.items.length > 0 ? (
        <HealthSummary
          total={dashboard.data.items.length}
          counts={countByHealth(dashboard.data.items)}
          value={health}
          onChange={setHealth}
        />
      ) : null}
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
