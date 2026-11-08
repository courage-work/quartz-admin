'use client';

import { AUDIT_ACTIONS, AUDIT_RESULTS, type AuditLogPage } from '@qa/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ListFilterIcon, ScrollTextIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { FormAlert } from '@/components/form/form-alert';
import { ListSearch } from '@/components/list/list-search';
import { PageHeader } from '@/components/shell/page-header';
import { TableFrame } from '@/components/table-frame';
import { AuditResultBadge } from '@/components/status/status-badge';
import { AUDIT_RESULT_META } from '@/components/status/tones';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
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
} from '@/lib/audit';
import { formatDateTime } from '@/lib/format';
import { AUDIT_ACTION_LABELS, auditActionLabel } from '@/lib/labels';

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
                초기화
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
  const chips: { key: string; label: string; clear: Partial<AuditFilter> }[] = [];
  if (value.username)
    chips.push({ key: 'user', label: `사용자: ${value.username}`, clear: { username: '' } });
  if (value.fromDate)
    chips.push({ key: 'from', label: `시작일: ${value.fromDate}`, clear: { fromDate: '' } });
  if (value.toDate)
    chips.push({ key: 'to', label: `종료일: ${value.toDate}`, clear: { toDate: '' } });
  if (value.action !== 'all')
    chips.push({
      key: 'action',
      label: `작업: ${auditActionLabel(value.action)}`,
      clear: { action: 'all' },
    });
  if (value.result !== 'all')
    chips.push({
      key: 'result',
      label: `결과: ${AUDIT_RESULT_META[value.result as keyof typeof AUDIT_RESULT_META]?.label ?? value.result}`,
      clear: { result: 'all' },
    });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="적용 중인 필터">
      {chips.map((c) => (
        <Button
          key={c.key}
          variant="secondary"
          size="sm"
          onClick={() => onChange({ ...value, ...c.clear })}
          aria-label={`${c.label} 필터 지우기`}
        >
          {c.label}
          <XIcon data-icon="inline-end" aria-hidden />
        </Button>
      ))}
      <Button variant="link" size="sm" onClick={() => onChange(EMPTY_AUDIT_FILTER)}>
        모두 지우기
      </Button>
    </div>
  );
}

/** 감사 로그 목록 (PRD FR-AUD-03). 최신 기록부터 50건씩 불러온다(기본 정렬: 최신순) */
export function AuditLogsView() {
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_AUDIT_FILTER);
  const [q, setQ] = useState('');
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.isPending ? (
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ScrollTextIcon aria-hidden />
                      </EmptyMedia>
                      <EmptyTitle>
                        {filtered ? '조건에 맞는 기록이 없습니다' : '아직 기록이 없습니다'}
                      </EmptyTitle>
                      <EmptyDescription>
                        {filtered
                          ? '기간을 넓히거나 필터를 지워 보세요.'
                          : '로그인이나 설정 변경이 일어나면 여기에 남습니다.'}
                      </EmptyDescription>
                    </EmptyHeader>
                    {filtered ? (
                      <EmptyContent>
                        <Button variant="outline" onClick={() => apply(EMPTY_AUDIT_FILTER)}>
                          필터 모두 지우기
                        </Button>
                      </EmptyContent>
                    ) : null}
                  </Empty>
                </TableCell>
              </TableRow>
            ) : (
              items.map((log) => (
                <TableRow key={log.id}>
                  <TableCell>
                    <Link
                      href={`/audit-log?id=${log.id}`}
                      className="text-primary underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground"
                    >
                      {formatDateTime(log.at)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">{describeActor(log)}</span>
                  </TableCell>
                  <TableCell>{auditActionLabel(log.action)}</TableCell>
                  <TableCell>
                    <span className="font-mono">{describeTarget(log)}</span>
                  </TableCell>
                  <TableCell>
                    <AuditResultBadge result={log.result} />
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">{log.ip ?? '-'}</span>
                  </TableCell>
                </TableRow>
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
