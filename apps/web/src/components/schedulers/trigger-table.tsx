'use client';

import type { TriggerDto } from '@qa/shared';
import Link from 'next/link';

import { Code } from '@/components/code';
import { TriggerStateBadge } from '@/components/status/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { describeSchedule, misfireLabel, triggerTypeLabel } from '@/lib/schedulers';

import { TimeCell } from './time-cell';

export function jobHref(schedulerId: number, group: string, name: string): string {
  const params = new URLSearchParams({ scheduler: String(schedulerId), group, name });
  return `/job?${params.toString()}`;
}

/**
 * 트리거 표 (FR-VIEW-04). 트리거 목록 탭과 잡 상세가 함께 쓴다.
 * 다음·이전 실행 시각은 사용자 타임존으로 보여 주고 CRON 트리거의 타임존을 함께 쓴다(FR-VIEW-09).
 */
export function TriggerTable({
  schedulerId,
  triggers,
  loading,
  showJob = true,
}: {
  schedulerId: number;
  triggers: TriggerDto[] | undefined;
  loading: boolean;
  showJob?: boolean;
}) {
  const columns = showJob ? 9 : 8;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>그룹 / 이름</TableHead>
          {showJob ? <TableHead>잡</TableHead> : null}
          <TableHead>상태</TableHead>
          <TableHead>타입</TableHead>
          <TableHead>일정</TableHead>
          <TableHead>다음 실행</TableHead>
          <TableHead>이전 실행</TableHead>
          <TableHead className="text-right">우선순위</TableHead>
          <TableHead>misfire 처리</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading && !triggers ? (
          Array.from({ length: 5 }, (_, i) => (
            <TableRow key={i}>
              <TableCell colSpan={columns}>
                <Skeleton className="h-5 w-full" />
              </TableCell>
            </TableRow>
          ))
        ) : triggers?.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns}>
              <span className="text-muted-foreground">조건에 맞는 트리거가 없습니다.</span>
            </TableCell>
          </TableRow>
        ) : (
          triggers?.map((t) => (
            <TableRow key={`${t.group}\u0000${t.name}`}>
              <TableCell>
                <span className="flex flex-col">
                  <span className="text-xs text-muted-foreground">{t.group}</span>
                  <span className="font-mono">{t.name}</span>
                  {t.calendarName ? (
                    <span className="text-xs text-muted-foreground">캘린더 {t.calendarName}</span>
                  ) : null}
                </span>
              </TableCell>
              {showJob ? (
                <TableCell>
                  <Link
                    href={jobHref(schedulerId, t.jobGroup, t.jobName)}
                    className="flex flex-col underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground"
                  >
                    <span className="text-xs text-muted-foreground">{t.jobGroup}</span>
                    <span className="font-mono">{t.jobName}</span>
                  </Link>
                </TableCell>
              ) : null}
              <TableCell>
                <TriggerStateBadge state={t.state} />
              </TableCell>
              <TableCell>{triggerTypeLabel(t.type)}</TableCell>
              <TableCell>
                {t.cron ? (
                  <span className="flex flex-col">
                    <Code>{t.cron.expression}</Code>
                    <span className="text-xs text-muted-foreground">
                      {t.cron.timeZone ?? 'JVM 기본 타임존'}
                    </span>
                  </span>
                ) : (
                  describeSchedule(t)
                )}
              </TableCell>
              <TableCell>
                <TimeCell ms={t.nextFireTime} timeZone={t.cron?.timeZone} />
              </TableCell>
              <TableCell>
                <TimeCell ms={t.prevFireTime} timeZone={t.cron?.timeZone} />
              </TableCell>
              <TableCell className="text-right">
                <span className="tabular-nums">{t.priority ?? '-'}</span>
              </TableCell>
              <TableCell>{misfireLabel(t.type, t.misfireInstruction)}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
