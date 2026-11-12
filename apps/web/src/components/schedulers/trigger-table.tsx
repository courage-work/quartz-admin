'use client';

import type { TriggerDto, TriggerSort } from '@qa/shared';
import { ArrowUpDownIcon, ArrowUpIcon, type LucideIcon, TimerIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Code } from '@/components/code';
import type { BatchSelection } from '@/components/commands/use-batch-selection';
import { InlineLink } from '@/components/links';
import { TableEmpty } from '@/components/table-empty';
import { TriggerStateBadge } from '@/components/status/status-badge';
import { Checkbox } from '@/components/ui/checkbox';
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

/** 열 머리를 눌러 정렬하는 칸. 서버가 오름차순만 주므로 방향은 바꾸지 않고, 지금 정렬 중인 열만 표시한다 */
function SortHead({
  label,
  active,
  onSort,
}: {
  label: string;
  active: boolean;
  onSort: () => void;
}) {
  return (
    <TableHead aria-sort={active ? 'ascending' : 'none'}>
      <button
        type="button"
        onClick={onSort}
        title={`${label} 순으로 정렬`}
        // 화살표는 칸 사이 여백 위에 띄워 열 폭을 늘리지 않는다(오른쪽 안쪽 여백만큼 바깥 여백을 뺀다).
        // 열이 넓어지면 1440px에서 표가 다시 가로로 넘친다
        className="relative -mr-5 -ml-2 inline-flex items-center rounded-sm py-1 pr-5 pl-2 font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:py-3"
      >
        {label}
        {active ? (
          <ArrowUpIcon className="absolute right-1 size-3.5" aria-hidden />
        ) : (
          <ArrowUpDownIcon
            className="absolute right-1 size-3.5 text-muted-foreground"
            aria-hidden
          />
        )}
      </button>
    </TableHead>
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
  sort,
  selection,
}: {
  schedulerId: number;
  triggers: TriggerDto[] | undefined;
  loading: boolean;
  showJob?: boolean;
  /** 빈 표 표시. 필터를 건 화면만 "조건에 맞는"이라고 쓰고 지우기 버튼을 둔다 */
  empty?: { icon: LucideIcon; title: string; action?: ReactNode };
  /** 줄 끝 제어 메뉴(`TriggerActions`). 없으면 열을 두지 않는다 */
  actions?: (trigger: TriggerDto) => ReactNode;
  /** 서버 정렬. 있으면 "그룹 / 이름"과 "다음 실행" 열 머리를 눌러 바꾼다(트리거 탭). 없으면 머리는 글자뿐이다 */
  sort?: { value: TriggerSort; onChange: (sort: TriggerSort) => void };
  /** 일괄 제어할 줄 고르기(FR-CTL-10, 트리거 탭). 있으면 맨 앞에 체크박스 열을 둔다 */
  selection?: BatchSelection<TriggerDto>;
}) {
  const columns = (showJob ? 8 : 7) + (actions ? 1 : 0) + (selection ? 1 : 0);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selection ? (
            <TableHead className="w-0">
              <Checkbox
                checked={selection.all}
                onCheckedChange={selection.toggleAll}
                disabled={!triggers?.length}
                aria-label="이 쪽의 트리거 모두 선택"
              />
            </TableHead>
          ) : null}
          {sort ? (
            <SortHead
              label="그룹 / 이름"
              active={sort.value === 'key'}
              onSort={() => sort.onChange('key')}
            />
          ) : (
            <TableHead>그룹 / 이름</TableHead>
          )}
          {showJob ? <TableHead>잡</TableHead> : null}
          <TableHead>상태</TableHead>
          <TableHead>일정</TableHead>
          {sort ? (
            <SortHead
              label="다음 실행"
              active={sort.value === 'nextFireTime'}
              onSort={() => sort.onChange('nextFireTime')}
            />
          ) : (
            <TableHead>다음 실행</TableHead>
          )}
          <TableHead>이전 실행</TableHead>
          <TableHead className="text-right">우선순위</TableHead>
          <TableHead>misfire 처리</TableHead>
          {actions ? (
            // 표가 넓어 가로로 스크롤돼도 제어 메뉴는 보이는 폭 안에 남긴다
            <TableHead pinned className="w-0">
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
            <TableRow
              key={`${t.group}\u0000${t.name}`}
              data-state={selection?.isSelected(t) ? 'selected' : undefined}
            >
              {selection ? (
                <TableCell>
                  <Checkbox
                    checked={selection.isSelected(t)}
                    onCheckedChange={() => selection.toggle(t)}
                    aria-label={`${t.group} / ${t.name} 선택`}
                  />
                </TableCell>
              ) : null}
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
              <TableCell>
                {/* 줄 높이가 같도록 항상 두 줄(일정 / 타입·타임존). 타입은 열을 따로 두지 않고 여기에 쓴다.
                    열 하나만큼 표가 좁아져 1440px에서 가로로 넘치지 않는다 */}
                <span className="flex flex-col">
                  {t.cron ? (
                    // flex 항목이 되면 Code의 세로 여백만큼 줄이 높아진다. 글줄 안에 두고, 글꼴이 섞여
                    // 줄 상자가 1px 커지지 않게 줄도 고정폭 글꼴로 둔다
                    <span className="font-mono">
                      <Code>{t.cron.expression}</Code>
                    </span>
                  ) : (
                    <span>{describeSchedule(t)}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {triggerTypeLabel(t.type)}
                    {t.cron ? ` · ${t.cron.timeZone ?? 'JVM 기본 타임존'}` : ''}
                  </span>
                </span>
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
              {actions ? (
                <TableCell pinned className="text-right">
                  {actions(t)}
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
