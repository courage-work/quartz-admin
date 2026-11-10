'use client';

import type { ConnectionDto } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { DatabaseIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import Link from 'next/link';

import { FormAlert } from '@/components/form/form-alert';
import { LinkRow, RowChevronCell, RowChevronHead, RowLink } from '@/components/links';
import { ListSearch } from '@/components/list/list-search';
import { PaginationBar } from '@/components/schedulers/pagination-bar';
import { TableEmpty } from '@/components/table-empty';
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
import { CLIENT_PAGE_SIZE, matchesQuery, paginate } from '@/lib/paging';
import { parsePage, setParam, type UrlCodec, useUrlState } from '@/lib/use-url-state';

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

/** 검색어·쪽 ↔ 주소(`q`, `page`). 접속 상세에 갔다 돌아와도 그대로다(B-40) */
const CONNECTIONS_CODEC: UrlCodec<{ q: string; page: number }> = {
  parse: (p) => ({ q: p.get('q') ?? '', page: parsePage(p.get('page')) }),
  write: (v, p) => {
    setParam(p, 'q', v.q);
    setParam(p, 'page', String(v.page), '1');
  },
};

/** 접속 목록 (FR-CON-01). 접속은 많지 않아 한 번에 받아 화면에서 거르고 나눈다 (기본 정렬: 이름순) */
export function ConnectionsView() {
  const connections = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: ({ signal }) => api<ConnectionDto[]>('/connections', { signal }),
  });
  const [view, setView] = useUrlState(CONNECTIONS_CODEC);
  const { q, page } = view;
  const setQ = (v: string) => setView((s) => ({ ...s, q: v }));
  const setPage = (v: number) => setView((s) => ({ ...s, page: v }));

  const filtered = (connections.data ?? [])
    .filter((c) =>
      matchesQuery(q, [c.name, c.host, c.username, c.envLabel, describeAddress(c), ...c.tags]),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const paged = paginate(filtered, page);

  let body;
  if (connections.isError) body = <FormAlert error={connections.error} />;
  else if (connections.data?.length === 0) body = <NoConnections />;
  else {
    body = (
      <>
        <ListSearch
          label="검색(이름·주소·계정·환경·태그)"
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          className="max-w-md"
        />
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead>환경</TableHead>
                <TableHead>태그</TableHead>
                <TableHead>DB</TableHead>
                <TableHead>주소</TableHead>
                <TableHead>계정</TableHead>
                <TableHead className="text-right">스케줄러</TableHead>
                <TableHead>권한</TableHead>
                <RowChevronHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.isPending ? (
                Array.from({ length: 3 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={9}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : paged.items.length === 0 ? (
                // 접속이 하나도 없으면 표 대신 NoConnections를 보이므로 여기는 검색 결과가 빈 경우다
                <TableEmpty
                  colSpan={9}
                  icon={SearchXIcon}
                  title="검색어에 맞는 접속이 없습니다"
                  action={
                    <Button variant="outline" onClick={() => setQ('')}>
                      검색어 지우기
                    </Button>
                  }
                />
              ) : (
                paged.items.map((conn) => (
                  <LinkRow key={conn.id}>
                    <TableCell>
                      <RowLink href={`/connection?id=${conn.id}`}>{conn.name}</RowLink>
                    </TableCell>
                    <TableCell>
                      <EnvBadge environment={conn.envLabel} />
                    </TableCell>
                    <TableCell>
                      {/* 태그 유무로 줄 높이가 달라지지 않게 따로 한 줄 칸에 두고, 길면 자른다 */}
                      {conn.tags.length > 0 ? (
                        <span
                          className="block max-w-48 truncate text-muted-foreground"
                          title={conn.tags.join(' · ')}
                        >
                          {conn.tags.join(' · ')}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
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
                    <RowChevronCell />
                  </LinkRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableFrame>
        <PaginationBar
          page={paged.page}
          size={CLIENT_PAGE_SIZE}
          total={paged.total}
          onPageChange={setPage}
        />
      </>
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
              접속 추가하기
            </Link>
          </Button>
        }
      />
      {body}
    </>
  );
}
