'use client';

import type { AuditLogDto } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { Code } from '@/components/code';
import { FormAlert } from '@/components/form/form-alert';
import { PageHeader } from '@/components/shell/page-header';
import { AuditResultBadge } from '@/components/status/status-badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { api, isApiError } from '@/lib/api';
import { describeActor, describeTarget } from '@/lib/audit';
import { formatDateTime } from '@/lib/format';
import { auditActionLabel } from '@/lib/labels';

/** `?id=` 값. 양의 정수가 아니면 null */
export function parseId(raw: string | null): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  return Number(raw);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="sm:col-span-3">{children}</dd>
    </>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {value === null ? (
          <p className="text-sm text-muted-foreground">기록 없음</p>
        ) : (
          <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm">
            {JSON.stringify(value, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function NotFound() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>감사 기록을 찾을 수 없습니다</EmptyTitle>
        <EmptyDescription>주소가 잘못됐거나 보존 기간이 지나 정리된 기록입니다.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href="/audit-logs">감사 로그 목록으로 가기</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function Detail({ log }: { log: AuditLogDto }) {
  return (
    <>
      <Card>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <Row label="시각">{formatDateTime(log.at)}</Row>
            <Row label="사용자">
              <span className="font-mono">{describeActor(log)}</span>
            </Row>
            <Row label="IP">
              <span className="font-mono">{log.ip ?? '-'}</span>
            </Row>
            <Row label="요청 ID">{log.requestId ? <Code>{log.requestId}</Code> : '-'}</Row>
            <Row label="작업">
              {auditActionLabel(log.action)} <Code>{log.action}</Code>
            </Row>
            <Row label="대상">
              <span className="font-mono">{describeTarget(log)}</span>
              {log.targetType ? (
                <span className="ml-2 text-muted-foreground">({log.targetType})</span>
              ) : null}
            </Row>
            <Row label="결과">
              <AuditResultBadge result={log.result} />
            </Row>
            {log.errorCode ? (
              <Row label="오류">
                <Code>{log.errorCode}</Code> {log.errorMessage}
              </Row>
            ) : null}
            {log.reason ? <Row label="사유">{log.reason}</Row> : null}
          </dl>
        </CardContent>
      </Card>
      <div className="grid gap-6 md:grid-cols-2">
        <JsonBlock title="변경 전" value={log.before} />
        <JsonBlock title="변경 후" value={log.after} />
      </div>
      <JsonBlock title="대상 정보" value={log.target} />
    </>
  );
}

/** 감사 기록 하나 (`/audit-log?id=N`). 정적 export라 ID를 쿼리로 받는다 (TRD §2.2) */
export function AuditLogDetail() {
  const id = parseId(useSearchParams().get('id'));
  const log = useQuery({
    queryKey: ['audit-logs', 'detail', id],
    queryFn: ({ signal }) => api<AuditLogDto>(`/audit-logs/${id}`, { signal }),
    enabled: id !== null,
  });

  let body: ReactNode;
  if (id === null || isApiError(log.error, 'NOT_FOUND')) body = <NotFound />;
  else if (log.isError) body = <FormAlert message={log.error.message} />;
  else if (log.isPending) body = <Skeleton className="h-64 w-full" />;
  else body = <Detail log={log.data} />;

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/audit-logs">감사 로그</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{id === null ? '기록' : `#${id}`}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageHeader title="감사 기록" />
      {body}
    </>
  );
}
