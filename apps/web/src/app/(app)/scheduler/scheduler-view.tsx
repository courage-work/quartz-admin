'use client';

import type { SchedulerDetailDto } from '@qa/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { FormAlert } from '@/components/form/form-alert';
import { InlineLink } from '@/components/links';
import { RefreshControls, useRefreshInterval } from '@/components/schedulers/refresh-controls';
import { SchedulerStats } from '@/components/schedulers/scheduler-stats';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import { SchedulerHealthBadge } from '@/components/status/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, isApiError } from '@/lib/api';
import { parseId } from '@/lib/navigation';
import { schedulerKey } from '@/lib/schedulers';

import { ExecutingTab, JobsTab, NodesTab, PausedGroupsTab, TriggersTab } from './tabs';

const TABS = [
  { value: 'triggers', label: '트리거' },
  { value: 'jobs', label: '잡' },
  { value: 'executing', label: '실행 중' },
  { value: 'nodes', label: '노드' },
  { value: 'paused', label: '일시정지 그룹' },
] as const;
type TabValue = (typeof TABS)[number]['value'];

function NotFound() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>스케줄러를 찾을 수 없습니다</EmptyTitle>
        <EmptyDescription>주소가 잘못됐거나 등록을 해제한 스케줄러입니다.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href="/">대시보드로 가기</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function Summary({ s }: { s: SchedulerDetailDto }) {
  const snap = s.snapshot;
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span>
        접속 <InlineLink href={`/connection?id=${s.connection.id}`}>{s.connection.name}</InlineLink>
      </span>
      <span className="font-mono">
        {s.tablePrefix}
        {' · '}
        {s.schedName}
      </span>
      {snap?.status === 'unreachable' ? (
        <span>
          {snap.errorMessage} (연속 {snap.consecutiveFailures}회)
        </span>
      ) : null}
      {snap ? null : <span>아직 감시하지 않았습니다</span>}
      {s.connection.readOnly || s.connection.writeCapable === false ? (
        <Badge variant="neutral">읽기 전용</Badge>
      ) : null}
    </span>
  );
}

/** 스케줄러 상세 (`/scheduler?id=N&tab=…`, FR-VIEW-02~05). 탭마다 대상 DB에서 바로 읽는다 */
export function SchedulerView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const id = parseId(params.get('id'));
  const tabParam = params.get('tab');
  const tab: TabValue = TABS.some((t) => t.value === tabParam)
    ? (tabParam as TabValue)
    : 'triggers';
  const [refreshMs, setRefreshMs] = useRefreshInterval();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: schedulerKey(id ?? 0),
    queryFn: ({ signal }) => api<SchedulerDetailDto>(`/schedulers/${id}`, { signal }),
    enabled: id !== null,
    refetchInterval: refreshMs || false,
  });

  if (id === null || isApiError(detail.error, 'NOT_FOUND')) return <NotFound />;
  if (detail.isError) return <FormAlert error={detail.error} />;
  if (detail.isPending) return <Skeleton className="h-64 w-full" />;
  const s = detail.data;

  const setTab = (value: string) => {
    // 탭마다 필터·쪽을 주소에 남기므로(B-40) 탭을 바꾸면 이전 탭의 값은 버린다
    const next = new URLSearchParams({ id: String(id), tab: value });
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <>
      <ProdStripe environment={s.connection.envLabel} name={s.displayName} />
      <PageHeader
        trail={[{ label: '대시보드', href: '/' }]}
        title={s.displayName}
        description={
          <span className="flex flex-col gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <EnvBadge environment={s.connection.envLabel} />
              {s.snapshot ? (
                <SchedulerHealthBadge health={s.snapshot.status} />
              ) : (
                <Badge variant="neutral">감시 전</Badge>
              )}
            </span>
            <Summary s={s} />
          </span>
        }
        actions={
          <RefreshControls
            dataTime={s.snapshot?.polledAt}
            dataTimeLabel="마지막 감시"
            refreshMs={refreshMs}
            onRefreshMsChange={setRefreshMs}
            onRefresh={() => void queryClient.invalidateQueries({ queryKey: ['schedulers', id] })}
            refreshing={queryClient.isFetching({ queryKey: ['schedulers', id] }) > 0}
          />
        }
      />
      <SchedulerStats s={s} />
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto overflow-y-hidden border-b border-border pb-0.5">
          <TabsList variant="line">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="triggers">
          <TriggersTab schedulerId={id} refreshMs={refreshMs} />
        </TabsContent>
        <TabsContent value="jobs">
          <JobsTab schedulerId={id} refreshMs={refreshMs} />
        </TabsContent>
        <TabsContent value="executing">
          <ExecutingTab schedulerId={id} refreshMs={refreshMs} />
        </TabsContent>
        <TabsContent value="nodes">
          <NodesTab schedulerId={id} refreshMs={refreshMs} />
        </TabsContent>
        <TabsContent value="paused">
          <PausedGroupsTab schedulerId={id} refreshMs={refreshMs} />
        </TabsContent>
      </Tabs>
    </>
  );
}
