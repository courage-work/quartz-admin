'use client';

import { AUDIT_ACTIONS, AUDIT_RESULTS, type AuditLogPage } from '@qa/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollTextIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { FormAlert } from '@/components/form/form-alert';
import { PageHeader } from '@/components/shell/page-header';
import { AuditResultBadge } from '@/components/status/status-badge';
import { AUDIT_RESULT_META } from '@/components/status/tones';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Empty,
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

function FilterForm({
  initial,
  onApply,
}: {
  initial: AuditFilter;
  onApply: (filter: AuditFilter) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = <K extends keyof AuditFilter>(key: K, value: AuditFilter[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply(draft);
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
              <SelectTrigger id="audit-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                {AUDIT_ACTIONS.map((action) => (
                  <SelectItem key={action} value={action}>
                    {AUDIT_ACTION_LABELS[action]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="audit-result">결과</FieldLabel>
            <Select value={draft.result} onValueChange={(v) => set('result', v)}>
              <SelectTrigger id="audit-result">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                {AUDIT_RESULTS.map((result) => (
                  <SelectItem key={result} value={result}>
                    {AUDIT_RESULT_META[result].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="audit-user">사용자 아이디</FieldLabel>
            <Input
              id="audit-user"
              value={draft.username}
              autoComplete="off"
              onChange={(e) => set('username', e.target.value)}
            />
          </Field>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-5 lg:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraft(EMPTY_AUDIT_FILTER);
                onApply(EMPTY_AUDIT_FILTER);
              }}
            >
              필터 지우기
            </Button>
            <Button type="submit">필터 적용하기</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** 감사 로그 목록 (PRD FR-AUD-03). 최신 기록부터 50건씩 불러온다 */
export function AuditLogsView() {
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_AUDIT_FILTER);
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

  return (
    <>
      <PageHeader
        title="감사 로그"
        description="로그인, 사용자 관리, 접속·스케줄러 변경과 제어 작업 기록입니다. 기록은 고치거나 지울 수 없습니다."
      />
      <FilterForm initial={filter} onApply={setFilter} />

      {logs.isError ? <FormAlert message={logs.error.message} /> : null}

      {logs.isSuccess && items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>조건에 맞는 기록이 없습니다</EmptyTitle>
            <EmptyDescription>기간을 넓히거나 필터를 지워 보세요.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {logs.isPending || items.length > 0 ? (
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
            {logs.isPending
              ? Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : items.map((log) => (
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
                ))}
          </TableBody>
        </Table>
      ) : null}

      {logs.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={logs.isFetchingNextPage}
            onClick={() => void logs.fetchNextPage()}
          >
            {logs.isFetchingNextPage ? <Spinner data-icon="inline-start" aria-hidden /> : null}더
            불러오기
          </Button>
        </div>
      ) : null}
    </>
  );
}
