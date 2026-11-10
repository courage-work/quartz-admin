'use client';

import { AUDIT_ACTIONS, AUDIT_RESULTS, type AuditLogPage } from '@qa/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ListFilterIcon, ScrollTextIcon, SearchXIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { FormAlert } from '@/components/form/form-alert';
import { LinkRow, RowChevronCell, RowChevronHead, RowLink } from '@/components/links';
import { type FilterChip, FilterChips } from '@/components/list/filter-chips';
import { ListSearch } from '@/components/list/list-search';
import { PageHeader } from '@/components/shell/page-header';
import { TableEmpty } from '@/components/table-empty';
import { TableFrame } from '@/components/table-frame';
import { AuditResultBadge } from '@/components/status/status-badge';
import { AUDIT_RESULT_META } from '@/components/status/tones';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  type AuditFilter,
  auditQuery,
  describeActor,
  describeTarget,
  EMPTY_AUDIT_FILTER,
  isCodeTarget,
  recentDays,
} from '@/lib/audit';
import { formatDateTime } from '@/lib/format';
import { AUDIT_ACTION_LABELS, auditActionLabel } from '@/lib/labels';
import { setParam, type UrlCodec, useUrlState } from '@/lib/use-url-state';

const QUICK_RANGES = [
  { days: 1, label: '오늘' },
  { days: 7, label: '최근 7일' },
  { days: 30, label: '최근 30일' },
] as const;

/** 필터 하나에 기간·작업 종류·결과를 모은다 (VectorLab list 패턴: Filters 컨트롤은 하나) */
function FilterPopover({
  value,
  onApply,
}: {
  value: AuditFilter;
  onApply: (filter: AuditFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const set = <K extends keyof AuditFilter>(key: K, v: AuditFilter[K]) =>
    setDraft((d) => ({ ...d, [key]: v }));
  const active = activeFilterCount(value);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply({ ...draft, username: value.username });
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(value);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline">
          <ListFilterIcon data-icon="inline-start" aria-hidden />
          필터{active > 0 ? ` (${active})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <form onSubmit={submit}>
          <FieldGroup>
            {/* 날짜를 두 번 고르지 않도록 자주 쓰는 기간을 한 번에 채운다 */}
            <div className="flex flex-col gap-2">
              <span id="audit-quick" className="text-sm font-medium">
                빠른 기간
              </span>
              <div role="group" aria-labelledby="audit-quick" className="flex flex-wrap gap-2">
                {QUICK_RANGES.map((r) => (
                  <Button
                    key={r.days}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDraft((d) => ({ ...d, ...recentDays(r.days) }))}
                  >
                    {r.label}
                  </Button>
                ))}
              </div>
            </div>
            <Field>
              <FieldLabel htmlFor="audit-from">시작일</FieldLabel>
              <Input
                id="audit-from"
                type="date"
                value={draft.fromDate}
                onChange={(e) => set('fromDate', e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="audit-to">종료일</FieldLabel>
              <Input
                id="audit-to"
                type="date"
                value={draft.toDate}
                onChange={(e) => set('toDate', e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="audit-action">작업 종류</FieldLabel>
              <Select value={draft.action} onValueChange={(v) => set('action', v)}>
                <SelectTrigger id="audit-action" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">전체</SelectItem>
                    {AUDIT_ACTIONS.map((action) => (
                      <SelectItem key={action} value={action}>
                        {AUDIT_ACTION_LABELS[action]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="audit-result">결과</FieldLabel>
              <Select value={draft.result} onValueChange={(v) => set('result', v)}>
                <SelectTrigger id="audit-result" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">전체</SelectItem>
                    {AUDIT_RESULTS.map((result) => (
                      <SelectItem key={result} value={result}>
                        {AUDIT_RESULT_META[result].label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft({ ...EMPTY_AUDIT_FILTER, username: draft.username })}
              >
                초기화하기
              </Button>
              <Button type="submit">필터 적용하기</Button>
            </div>
          </FieldGroup>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** 사용자 아이디를 뺀 필터 수(검색칸은 따로 보인다) */
function activeFilterCount(f: AuditFilter): number {
  return [f.fromDate, f.toDate, f.action !== 'all', f.result !== 'all'].filter(Boolean).length;
}

/** 적용 중인 필터를 툴바 아래 칩으로 보여 주고 하나씩 지울 수 있게 한다 */
function ActiveFilters({
  value,
  onChange,
}: {
  value: AuditFilter;
  onChange: (filter: AuditFilter) => void;
}) {
  const chips: FilterChip[] = [];
  const clear = (patch: Partial<AuditFilter>) => () => onChange({ ...value, ...patch });
  if (value.username)
    chips.push({
      key: 'user',
      label: `사용자: ${value.username}`,
      onClear: clear({ username: '' }),
    });
  if (value.fromDate)
    chips.push({
      key: 'from',
      label: `시작일: ${value.fromDate}`,
      onClear: clear({ fromDate: '' }),
    });
  if (value.toDate)
    chips.push({ key: 'to', label: `종료일: ${value.toDate}`, onClear: clear({ toDate: '' }) });
  if (value.action !== 'all')
    chips.push({
      key: 'action',
      label: `작업: ${auditActionLabel(value.action)}`,
      onClear: clear({ action: 'all' }),
    });
  if (value.result !== 'all')
    chips.push({
      key: 'result',
      label: `결과: ${AUDIT_RESULT_META[value.result as keyof typeof AUDIT_RESULT_META]?.label ?? value.result}`,
      onClear: clear({ result: 'all' }),
    });
  return <FilterChips chips={chips} onClearAll={() => onChange(EMPTY_AUDIT_FILTER)} />;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 필터 ↔ 주소(`from`, `to`, `action`, `result`, `user`). 기록 상세에 갔다 돌아와도 그대로다(B-40) */
const AUDIT_CODEC: UrlCodec<AuditFilter> = {
  parse: (p) => {
    const date = (key: string) => {
      const v = p.get(key) ?? '';
      return DATE_RE.test(v) ? v : '';
    };
    // 주소를 손으로 고쳐도 서버가 거절하는 값은 보내지 않는다
    const oneOf = (key: string, allowed: readonly string[], empty: string) => {
      const v = p.get(key) ?? '';
      return allowed.includes(v) ? v : empty;
    };
    return {
      fromDate: date('from'),
      toDate: date('to'),
      action: oneOf('action', AUDIT_ACTIONS, EMPTY_AUDIT_FILTER.action),
      result: oneOf('result', AUDIT_RESULTS, EMPTY_AUDIT_FILTER.result),
      username: p.get('user') ?? '',
    };
  },
  write: (v, p) => {
    setParam(p, 'from', v.fromDate);
    setParam(p, 'to', v.toDate);
    setParam(p, 'action', v.action, EMPTY_AUDIT_FILTER.action);
    setParam(p, 'result', v.result, EMPTY_AUDIT_FILTER.result);
    setParam(p, 'user', v.username);
  },
};

/** 감사 로그 목록 (PRD FR-AUD-03). 최신 기록부터 50건씩 불러온다(기본 정렬: 최신순) */
export function AuditLogsView() {
  const [filter, setFilter] = useUrlState(AUDIT_CODEC);
  const [q, setQ] = useState(filter.username);
  const logs = useInfiniteQuery({
    queryKey: ['audit-logs', filter],
    queryFn: ({ pageParam, signal }) =>
      api<AuditLogPage>('/audit-logs', {
        query: { ...auditQuery(filter), cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];
  const apply = (next: AuditFilter) => {
    setFilter(next);
    setQ(next.username);
  };
  const filtered = activeFilterCount(filter) > 0 || filter.username !== '';

  return (
    <>
      <PageHeader
        title="감사 로그"
        description="로그인, 사용자 관리, 접속·스케줄러 변경과 제어 작업 기록입니다. 기록은 고치거나 지울 수 없습니다."
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <ListSearch
            label="검색(사용자 아이디, 정확히 일치)"
            value={q}
            onChange={(v) => {
              setQ(v);
              if (v === '' && filter.username !== '') setFilter({ ...filter, username: '' });
            }}
            onSubmit={() => setFilter({ ...filter, username: q.trim().toLowerCase() })}
            className="w-full max-w-md"
          />
          <FilterPopover value={filter} onApply={apply} />
        </div>
        <ActiveFilters value={filter} onChange={apply} />
      </div>

      {logs.isError ? <FormAlert error={logs.error} /> : null}

      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>시각</TableHead>
              <TableHead>사용자</TableHead>
              <TableHead>작업</TableHead>
              <TableHead>대상</TableHead>
              <TableHead>결과</TableHead>
              <TableHead>IP</TableHead>
              <RowChevronHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.isPending ? (
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : items.length === 0 ? (
              filtered ? (
                <TableEmpty
                  colSpan={7}
                  icon={SearchXIcon}
                  title="조건에 맞는 기록이 없습니다"
                  description="기간을 넓히거나 필터를 지워 보세요."
                  action={
                    <Button variant="outline" onClick={() => apply(EMPTY_AUDIT_FILTER)}>
                      필터 모두 지우기
                    </Button>
                  }
                />
              ) : (
                <TableEmpty
                  colSpan={7}
                  icon={ScrollTextIcon}
                  title="아직 기록이 없습니다"
                  description="로그인이나 설정 변경이 일어나면 여기에 남습니다."
                />
              )
            ) : (
              items.map((log) => (
                <LinkRow key={log.id}>
                  <TableCell>
                    <RowLink href={`/audit-log?id=${log.id}`} className="tabular-nums">
                      {formatDateTime(log.at)}
                    </RowLink>
                  </TableCell>
                  <TableCell>
                    <span className={log.username ? 'font-mono' : undefined}>
                      {describeActor(log)}
                    </span>
                  </TableCell>
                  <TableCell>{auditActionLabel(log.action)}</TableCell>
                  <TableCell>
                    <span className={isCodeTarget(log) ? 'font-mono' : undefined}>
                      {describeTarget(log)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <AuditResultBadge result={log.result} errorCode={log.errorCode} />
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">{log.ip ?? '-'}</span>
                  </TableCell>
                  <RowChevronCell />
                </LinkRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableFrame>

      {/* 페이지 이동은 항상 보인다. 더 없으면 버튼을 잠그되 글자는 남긴다 */}
      {logs.isSuccess ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground tabular-nums">
            {items.length.toLocaleString()}건 표시
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!logs.hasNextPage || logs.isFetchingNextPage}
            onClick={() => void logs.fetchNextPage()}
          >
            {logs.isFetchingNextPage ? <Spinner data-icon="inline-start" aria-hidden /> : null}
            {logs.hasNextPage ? '50건 더 불러오기' : '마지막 기록까지 불러왔습니다'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
