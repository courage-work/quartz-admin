'use client';

import type { JobDataDto, JobDetailResponse, SchedulerDetailDto } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import {
  BracesIcon,
  EyeIcon,
  EyeOffIcon,
  FileLockIcon,
  SearchXIcon,
  TimerIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Code } from '@/components/code';
import { useCommandDialog } from '@/components/commands/use-command-dialog';
import { FormAlert } from '@/components/form/form-alert';
import { RefreshControls, useRefreshInterval } from '@/components/schedulers/refresh-controls';
import { TriggerActions } from '@/components/schedulers/trigger-actions';
import { TriggerTable } from '@/components/schedulers/trigger-table';
import { PageHeader } from '@/components/shell/page-header';
import { TableEmpty } from '@/components/table-empty';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, isApiError } from '@/lib/api';
import { controlBlockedReason } from '@/lib/commands';
import { formatDateTime } from '@/lib/format';
import { parseId } from '@/lib/navigation';
import { schedulerKey, schedulerViewKey } from '@/lib/schedulers';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="md:col-span-3">{children}</dd>
    </>
  );
}

/**
 * JobDataMap (FR-VIEW-08, TRD §8.3). 비밀값이 들어 있을 수 있어 값은 기본으로 가리고, 누르면 보인다.
 * Java 직렬화 형식은 클래스 정보 없이 읽을 수 없어 표시하지 않는다.
 */
function JobDataCard({ data }: { data: JobDataDto }) {
  const [shown, setShown] = useState(false);
  let body: ReactNode;
  if (data.format === 'java-serialized' || data.format === 'unreadable')
    body = (
      <Alert>
        <FileLockIcon aria-hidden />
        <AlertTitle>
          {data.format === 'java-serialized'
            ? 'Java 직렬화 형식이라 표시할 수 없습니다'
            : '읽을 수 없는 형식입니다'}
        </AlertTitle>
        <AlertDescription>
          {data.bytes.toLocaleString()}바이트. Quartz를{' '}
          <Code>org.quartz.jobStore.useProperties=true</Code>로 쓰면 키-값으로 저장돼 여기서 볼 수
          있습니다.
        </AlertDescription>
      </Alert>
    );
  else {
    const entries = data.format === 'properties' ? data.entries : [];
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>키</TableHead>
            <TableHead>값</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 ? (
            <TableEmpty colSpan={2} icon={BracesIcon} title="JobDataMap이 비어 있습니다" />
          ) : (
            entries.map((e) => (
              <TableRow key={e.key}>
                <TableCell>
                  <span className="font-mono">{e.key}</span>
                </TableCell>
                <TableCell>
                  <span className="font-mono break-all">{shown ? e.value : '••••••'}</span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <div className="flex items-center justify-between gap-2">
            <span>JobDataMap</span>
            {data.format === 'properties' && data.entries.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setShown((v) => !v)}>
                {shown ? (
                  <EyeOffIcon data-icon="inline-start" aria-hidden />
                ) : (
                  <EyeIcon data-icon="inline-start" aria-hidden />
                )}
                {shown ? '값 가리기' : '값 보기'}
              </Button>
            ) : null}
          </div>
        </CardTitle>
        <CardDescription>
          읽기 전용입니다. 비밀값이 있을 수 있어 값은 기본으로 가립니다.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function NotFound({ schedulerId }: { schedulerId: number | null }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>잡을 찾을 수 없습니다</EmptyTitle>
        <EmptyDescription>주소가 잘못됐거나 이미 지워진 잡입니다.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href={schedulerId === null ? '/' : `/scheduler?id=${schedulerId}&tab=jobs`}>
            잡 목록으로 가기
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** 잡 상세 (`/job?scheduler=N&group=&name=`, FR-VIEW-03, 08). 키에 `/`가 들어갈 수 있어 쿼리로 받는다 */
export function JobView() {
  const params = useSearchParams();
  const schedulerId = parseId(params.get('scheduler'));
  const group = params.get('group');
  const name = params.get('name');
  const valid = schedulerId !== null && !!group && !!name;
  const [refreshMs, setRefreshMs] = useRefreshInterval();

  const scheduler = useQuery({
    queryKey: schedulerKey(schedulerId ?? 0),
    queryFn: ({ signal }) => api<SchedulerDetailDto>(`/schedulers/${schedulerId}`, { signal }),
    enabled: schedulerId !== null,
  });
  const detail = useQuery({
    queryKey: schedulerViewKey(schedulerId ?? 0, 'job', { group, name }),
    queryFn: ({ signal }) =>
      api<JobDetailResponse>(`/schedulers/${schedulerId}/jobs/detail`, {
        query: { group, name },
        signal,
      }),
    enabled: valid,
    refetchInterval: refreshMs || false,
  });
  const { openCommand, dialog } = useCommandDialog(schedulerId ?? 0);

  let body: ReactNode;
  if (!valid || isApiError(detail.error, 'NOT_FOUND'))
    body = <NotFound schedulerId={schedulerId} />;
  else if (detail.isError) body = <FormAlert error={detail.error} />;
  else if (detail.isPending) body = <Skeleton className="h-64 w-full" />;
  else {
    const { job, triggers, jobData } = detail.data;
    const yesNo = (v: boolean | null) => (v === null ? '-' : v ? '예' : '아니요');
    body = (
      <>
        <Card>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-4">
              <Row label="그룹">
                <span className="font-mono">{job.group}</span>
              </Row>
              <Row label="잡 클래스">
                <span className="font-mono">{job.jobClass}</span>
              </Row>
              <Row label="설명">{job.description ?? '-'}</Row>
              <Row label="durable">{yesNo(job.durable)}</Row>
              <Row label="동시 실행 금지">{yesNo(job.nonConcurrent)}</Row>
              <Row label="실행 후 데이터 저장">{yesNo(job.updateData)}</Row>
              <Row label="복구 요청">{yesNo(job.requestsRecovery)}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>트리거 {triggers.length}개</CardTitle>
            <CardDescription>대상 DB 시각 {formatDateTime(detail.data.dbNow)} 기준</CardDescription>
          </CardHeader>
          <CardContent>
            <TriggerTable
              schedulerId={schedulerId}
              triggers={triggers}
              loading={false}
              showJob={false}
              empty={{ icon: TimerIcon, title: '이 잡을 실행하는 트리거가 없습니다' }}
              actions={(t) => (
                <TriggerActions
                  trigger={t}
                  blockedReason={
                    scheduler.data
                      ? controlBlockedReason(scheduler.data.connection)
                      : '스케줄러 정보를 읽는 중입니다'
                  }
                  onCommand={openCommand}
                />
              )}
            />
          </CardContent>
        </Card>
        <JobDataCard data={jobData} />
      </>
    );
  }

  const s = scheduler.data;
  return (
    <>
      {s ? <ProdStripe environment={s.connection.envLabel} name={s.displayName} /> : null}
      <PageHeader
        trail={[
          { label: '대시보드', href: '/' },
          ...(schedulerId !== null
            ? [
                {
                  label: s?.displayName ?? '스케줄러',
                  // 잡 목록에서 오지 않았어도(트리거 탭 등) 마지막으로 본 탭으로 돌아간다
                  href: `/scheduler?id=${schedulerId}&tab=jobs`,
                },
              ]
            : []),
        ]}
        title={name ?? '잡'}
        description={s ? <EnvBadge environment={s.connection.envLabel} /> : undefined}
        actions={
          <RefreshControls
            dataTime={detail.data?.dbNow}
            dataTimeLabel="대상 DB 시각"
            refreshMs={refreshMs}
            onRefreshMsChange={setRefreshMs}
            onRefresh={() => void detail.refetch()}
            refreshing={detail.isFetching}
          />
        }
      />
      {body}
      {dialog}
    </>
  );
}
