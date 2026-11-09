'use client';

import type { TriggerDto } from '@qa/shared';
import { type LucideIcon, TimerIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Code } from '@/components/code';
import { InlineLink } from '@/components/links';
import { TableEmpty } from '@/components/table-empty';
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

/** 트리거·실행 기록 줄 안에서 그 잡의 상세로 가는 글자 링크. 그룹은 위에 옅게 적는다 */
export function JobLink({
  schedulerId,
  group,
  name,
}: {
  schedulerId: number;
  group: string;
  name: string;
}) {
  return (
    <span className="flex flex-col items-start">
      <span className="text-xs text-muted-foreground">{group}</span>
      <InlineLink href={jobHref(schedulerId, group, name)} className="font-mono font-normal">
        {name}
      </InlineLink>
    </span>
  );
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
  empty = { icon: TimerIcon, title: '트리거가 없습니다' },
  actions,
}: {
  schedulerId: number;
  triggers: TriggerDto[] | undefined;
  loading: boolean;
  showJob?: boolean;
  /** 빈 표 표시. 필터를 건 화면만 "조건에 맞는"이라고 쓰고 지우기 버튼을 둔다 */
  empty?: { icon: LucideIcon; title: string; action?: ReactNode };
  /** 줄 끝 제어 메뉴(`TriggerActions`). 없으면 열을 두지 않는다 */
  actions?: (trigger: TriggerDto) => ReactNode;
}) {
  const columns = (showJob ? 9 : 8) + (actions ? 1 : 0);
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
          {actions ? (
            <TableHead className="w-0">
              <span className="sr-only">제어</span>
            </TableHead>
          ) : null}
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
          <TableEmpty
            colSpan={columns}
            icon={empty.icon}
            title={empty.title}
            action={empty.action}
          />
        ) : (
          triggers?.map((t) => (
            <TableRow key={`${t.group}\u0000${t.name}`}>
              <TableCell>
                {/* 줄 높이가 같도록 항상 두 줄(그룹·캘린더 / 이름). 캘린더는 그룹 줄 뒤에 붙인다 */}
                <span className="flex flex-col">
                  <span className="text-xs text-muted-foreground">
                    {t.group}
                    {t.calendarName ? ` · 캘린더 ${t.calendarName}` : ''}
                  </span>
                  <span className="font-mono">{t.name}</span>
                </span>
              </TableCell>
              {showJob ? (
                <TableCell>
                  <JobLink schedulerId={schedulerId} group={t.jobGroup} name={t.jobName} />
                </TableCell>
              ) : null}
              <TableCell>
                <TriggerStateBadge state={t.state} />
              </TableCell>
              <TableCell>{triggerTypeLabel(t.type)}</TableCell>
              <TableCell>
                {t.cron ? (
                  <span className="flex flex-col">
                    {/* flex 항목이 되면 Code의 세로 여백만큼 줄이 높아진다. 글줄 안에 두고, 글꼴이 섞여
                        줄 상자가 1px 커지지 않게 줄도 고정폭 글꼴로 둔다 */}
                    <span className="font-mono">
                      <Code>{t.cron.expression}</Code>
                    </span>
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
              {actions ? <TableCell className="text-right">{actions(t)}</TableCell> : null}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
