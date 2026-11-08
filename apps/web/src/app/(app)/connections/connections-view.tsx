'use client';

import type { ConnectionDto } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';

import { FormAlert } from '@/components/form/form-alert';
import { TableFrame } from '@/components/table-frame';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge } from '@/components/status/environment';
import { Button } from '@/components/ui/button';
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
import { api } from '@/lib/api';
import { CONNECTIONS_KEY, DB_KIND_LABELS, describeAddress } from '@/lib/connections';

import { WriteStatusBadge } from '@/components/connections/write-status-badge';

function NoConnections() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DatabaseIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>아직 등록한 접속이 없습니다</EmptyTitle>
        <EmptyDescription>
          Quartz 테이블이 있는 DB를 등록하면 스케줄러를 자동으로 찾아 줍니다.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href="/connections/new">
            <PlusIcon data-icon="inline-start" aria-hidden />
            접속 추가하기
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** 접속 목록 (FR-CON-01) */
export function ConnectionsView() {
  const connections = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: ({ signal }) => api<ConnectionDto[]>('/connections', { signal }),
  });

  let body;
  if (connections.isError) body = <FormAlert message={connections.error.message} />;
  else if (connections.data?.length === 0) body = <NoConnections />;
  else {
    body = (
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>이름</TableHead>
              <TableHead>환경</TableHead>
              <TableHead>DB</TableHead>
              <TableHead>주소</TableHead>
              <TableHead>계정</TableHead>
              <TableHead className="text-right">스케줄러</TableHead>
              <TableHead>권한</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.isPending
              ? Array.from({ length: 3 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : connections.data.map((conn) => (
                  <TableRow key={conn.id}>
                    <TableCell>
                      <Link
                        href={`/connection?id=${conn.id}`}
                        className="font-medium underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground"
                      >
                        {conn.name}
                      </Link>
                      {conn.tags.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          <span className="sr-only">태그: </span>
                          {conn.tags.join(' · ')}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <EnvBadge environment={conn.envLabel} />
                    </TableCell>
                    <TableCell>{DB_KIND_LABELS[conn.dbType]}</TableCell>
                    <TableCell>
                      <span className="font-mono">{describeAddress(conn)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono">{conn.username}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">{conn.schedulerCount}</span>
                    </TableCell>
                    <TableCell>
                      <WriteStatusBadge connection={conn} />
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </TableFrame>
    );
  }

  return (
    <>
      <PageHeader
        title="접속"
        description="Quartz 테이블이 있는 DB 접속입니다. 접속 하나에 스케줄러를 여러 개 등록할 수 있습니다."
        actions={
          <Button asChild>
            <Link href="/connections/new">
              <PlusIcon data-icon="inline-start" aria-hidden />
              접속 추가
            </Link>
          </Button>
        }
      />
      {body}
    </>
  );
}
