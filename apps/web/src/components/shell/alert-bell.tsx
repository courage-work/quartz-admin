'use client';

import type { AlertSummaryDto } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { BellIcon } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { ALERT_SUMMARY_KEY, ALERT_SUMMARY_REFRESH_MS } from '@/lib/channels';

/** 99를 넘으면 `99+` */
function countLabel(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/**
 * 상단 바의 알림 센터 버튼 (FR-ALT-07, TRD §9.4). 30초마다 읽지 않은 수를 읽어 붙인다.
 * 발송 실패가 있으면 수 대신 느낌표를 붙여 알림 센터에서 보게 한다.
 */
export function AlertBell() {
  const summary = useQuery({
    queryKey: ALERT_SUMMARY_KEY,
    queryFn: ({ signal }) => api<AlertSummaryDto>('/alerts/summary', { signal }),
    refetchInterval: ALERT_SUMMARY_REFRESH_MS,
  });
  const unread = summary.data?.unread ?? 0;
  const failed = summary.data?.failedDeliveries ?? 0;
  const label = [
    '알림 센터',
    unread > 0 ? `읽지 않은 알림 ${unread}개` : null,
    failed > 0 ? `발송 실패 ${failed}건` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon">
          <Link href="/alerts" aria-label={label} className="relative">
            <BellIcon aria-hidden />
            {unread > 0 ? (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-xs leading-none font-medium text-destructive-foreground tabular-nums"
              >
                {countLabel(unread)}
              </span>
            ) : failed > 0 ? (
              <span aria-hidden className="absolute top-1 right-1 size-2 rounded-full bg-warning" />
            ) : null}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
