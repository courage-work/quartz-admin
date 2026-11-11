'use client';

import {
  ALERT_RULE_LABELS,
  type AlertCenterItemDto,
  type AlertCenterPage,
  type AlertCenterStatus,
  type AlertSummaryDto,
  describeAffected,
  type DeliveryFailureDto,
} from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellOffIcon,
  CheckCheckIcon,
  CheckIcon,
  CircleCheckIcon,
  MailOpenIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { FormAlert } from '@/components/form/form-alert';
import { InlineLink } from '@/components/links';
import { PaginationBar } from '@/components/schedulers/pagination-bar';
import { TimeCell } from '@/components/schedulers/time-cell';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge } from '@/components/status/environment';
import { SeverityBadge } from '@/components/status/status-badge';
import { TableEmpty } from '@/components/table-empty';
import { TableFrame } from '@/components/table-frame';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { describeAlertStatus } from '@/lib/alerts';
import { api } from '@/lib/api';
import {
  ALERT_SUMMARY_KEY,
  ALERT_SUMMARY_REFRESH_MS,
  alertCenterKey,
  DELIVERY_FAILURES_KEY,
  describeFailure,
  EVENT_LABELS,
} from '@/lib/channels';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';

const STATUS_OPTIONS: { value: AlertCenterStatus; label: string }[] = [
  { value: 'active', label: '해소 전' },
  { value: 'resolved', label: '해소' },
  { value: 'all', label: '모두' },
];

/** 끝내 보내지 못한 발송. 발송 실패도 인앱으로 알린다 (TRD §9.4) */
function DeliveryFailures({ count }: { count: number }) {
  const failures = useQuery({
    queryKey: DELIVERY_FAILURES_KEY,
    queryFn: ({ signal }) =>
      api<{ items: DeliveryFailureDto[] }>('/alerts/delivery-failures', { signal }),
    enabled: count > 0,
  });
  if (count === 0) return null;
  const items = failures.data?.items ?? [];
  return (
    <Alert variant="warning">
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>최근 7일 동안 보내지 못한 알림이 {count}건 있습니다</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {items.slice(0, 5).map((f) => (
            <li key={f.id}>
              {formatDateTime(f.createdAt)} · {f.channelName} · {f.schedulerName}{' '}
              {ALERT_RULE_LABELS[f.alertType]} {EVENT_LABELS[f.event]} — {describeFailure(f)}
            </li>
          ))}
        </ul>
        <span className="mt-1 block">
          채널 설정을 확인하세요. <InlineLink href="/channels">알림 채널</InlineLink>에서 테스트
          발송으로 확인할 수 있습니다.
        </span>
      </AlertDescription>
    </Alert>
  );
}

function AlertRow({
  alert,
  onAck,
  onRead,
  busy,
}: {
  alert: AlertCenterItemDto;
  onAck: (a: AlertCenterItemDto) => void;
  onRead: (a: AlertCenterItemDto) => void;
  busy: boolean;
}) {
  const rule = ALERT_RULE_LABELS[alert.type];
  return (
    <TableRow data-state={alert.unread ? 'selected' : undefined}>
      <TableCell className="w-6">
        {alert.unread ? (
          <span className="block size-2 rounded-full bg-primary" title="읽지 않음">
            <span className="sr-only">읽지 않음</span>
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <SeverityBadge severity={alert.severity} />
      </TableCell>
      <TableCell>
        <span className="flex flex-col">
          <span className={alert.unread ? 'font-medium' : undefined}>{rule}</span>
          <span className="block max-w-72 truncate text-xs text-muted-foreground">
            {describeAffected(alert.affected)}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex flex-col items-start gap-1">
          <InlineLink href={`/scheduler?id=${alert.schedulerId}&tab=alerts`}>
            {alert.schedulerName}
          </InlineLink>
          {alert.envLabel ? <EnvBadge environment={alert.envLabel} /> : null}
        </span>
      </TableCell>
      <TableCell>
        <TimeCell ms={alert.firstSeenAt} />
      </TableCell>
      <TableCell>
        {/* 한 표 안의 줄 높이를 맞추려고 모든 줄이 두 줄이다(DESIGN §8.1.2) */}
        <span className="flex flex-col">
          <span>{describeAlertStatus(alert)}</span>
          <span className="text-xs text-muted-foreground">
            {alert.status === 'resolved'
              ? formatDateTime(alert.resolvedAt)
              : alert.status === 'acked'
                ? (alert.ackedBy ?? '-')
                : '확인 전'}
          </span>
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex gap-1">
          {alert.unread ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={`${rule} 알림 읽음으로 표시`}
                  onClick={() => onRead(alert)}
                >
                  <MailOpenIcon aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>읽음으로 표시</TooltipContent>
            </Tooltip>
          ) : null}
          {alert.status === 'open' ? (
            <Button variant="outline" disabled={busy} onClick={() => onAck(alert)}>
              <CheckIcon data-icon="inline-start" aria-hidden />
              확인하기
            </Button>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

/**
 * 인앱 알림 센터 (`/alerts`, FR-ALT-07). 모든 스케줄러의 알림을 한곳에서 보고 읽음·확인 처리한다.
 * 확인하면 재알림이 멈추고, 해소 알림은 그대로 온다 (TRD §9.3).
 */
export function AlertsView() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AlertCenterStatus>('active');
  const [page, setPage] = useState(1);
  usePageTitle('알림 센터');

  const summary = useQuery({
    queryKey: ALERT_SUMMARY_KEY,
    queryFn: ({ signal }) => api<AlertSummaryDto>('/alerts/summary', { signal }),
    refetchInterval: ALERT_SUMMARY_REFRESH_MS,
  });
  const list = useQuery({
    queryKey: alertCenterKey(status, page),
    queryFn: ({ signal }) => api<AlertCenterPage>('/alerts', { query: { status, page }, signal }),
    refetchInterval: ALERT_SUMMARY_REFRESH_MS,
    placeholderData: (prev) => prev,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['alerts'] });

  const read = useMutation({
    mutationFn: (a: AlertCenterItemDto) => api<void>(`/alerts/${a.id}/read`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const readAll = useMutation({
    mutationFn: () => api<{ changed: number }>('/alerts/read-all', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(
        r.changed > 0 ? `알림 ${r.changed}개를 읽음으로 표시했습니다` : '읽지 않은 알림이 없습니다',
      );
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const ack = useMutation({
    mutationFn: (a: AlertCenterItemDto) =>
      api<{ changed: boolean }>(`/alerts/${a.id}/ack`, { method: 'POST' }),
    onSuccess: (_, a) => {
      toast.success(
        `${a.schedulerName} ${ALERT_RULE_LABELS[a.type]} 알림을 확인했습니다. 재알림을 멈추고, 해소되면 알려 드립니다`,
      );
      refresh();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
      refresh();
    },
  });
  const busy = read.isPending || ack.isPending || readAll.isPending;
  const unread = summary.data?.unread ?? 0;

  return (
    <>
      <PageHeader
        title="알림 센터"
        description="모든 스케줄러의 알림입니다. 확인하면 재알림이 멈추고, 해소되면 다시 알려 드립니다."
        actions={
          <Button
            variant="outline"
            disabled={unread === 0 || readAll.isPending}
            onClick={() => readAll.mutate()}
          >
            <CheckCheckIcon data-icon="inline-start" aria-hidden />
            모두 읽음으로 표시
          </Button>
        }
      />
      <DeliveryFailures count={summary.data?.failedDeliveries ?? 0} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          value={status}
          onValueChange={(v) => {
            if (!v) return;
            setStatus(v as AlertCenterStatus);
            setPage(1);
          }}
          aria-label="알림 상태"
        >
          {STATUS_OPTIONS.map((o) => (
            <ToggleGroupItem key={o.value} value={o.value}>
              {o.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-sm text-muted-foreground">
          읽지 않음 {unread}개 · 해소 전 {summary.data?.open ?? 0}개
        </p>
      </div>
      {list.isError ? <FormAlert error={list.error} /> : null}
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6">
                <span className="sr-only">읽음</span>
              </TableHead>
              <TableHead className="w-24">심각도</TableHead>
              <TableHead>규칙 / 대상</TableHead>
              <TableHead>스케줄러</TableHead>
              <TableHead>발생</TableHead>
              <TableHead>상태</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">작업</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!list.data ? (
              Array.from({ length: 3 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : list.data.items.length === 0 ? (
              <TableEmpty
                colSpan={7}
                icon={status === 'resolved' ? BellOffIcon : CircleCheckIcon}
                title={status === 'active' ? '해소 전 알림이 없습니다' : '알림이 없습니다'}
                description={
                  status === 'active' ? (
                    <>
                      규칙은 스케줄러 화면의 알림 탭에서,{' '}
                      <Link href="/channels" className="underline underline-offset-4">
                        보낼 곳
                      </Link>
                      은 알림 채널에서 정합니다.
                    </>
                  ) : undefined
                }
              />
            ) : (
              list.data.items.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  busy={busy}
                  onRead={(x) => read.mutate(x)}
                  onAck={(x) => ack.mutate(x)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </TableFrame>
      {list.data ? (
        <PaginationBar
          page={list.data.page}
          size={list.data.pageSize}
          total={list.data.total}
          onPageChange={setPage}
        />
      ) : null}
    </>
  );
}
