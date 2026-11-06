'use client';

import {
  type ExecutingResponse,
  type JobDto,
  type JobListQuery,
  type NodesResponse,
  type Page,
  type PausedGroupsResponse,
  TRIGGER_STATES,
  TRIGGER_TYPES,
  type TriggerDto,
  type TriggerListQuery,
  type TriggerSort,
} from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleCheckIcon, HistoryIcon, PauseIcon, SearchIcon, UnplugIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useId, useState } from 'react';

import { FormAlert } from '@/components/form/form-alert';
import { PaginationBar } from '@/components/schedulers/pagination-bar';
import { TimeCell } from '@/components/schedulers/time-cell';
import { jobHref, TriggerTable } from '@/components/schedulers/trigger-table';
import { TriggerStateBadge } from '@/components/status/status-badge';
import { TRIGGER_STATE_META } from '@/components/status/tones';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, type Query } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatAgo, formatInterval, schedulerViewKey, TRIGGER_TYPE_LABELS } from '@/lib/schedulers';

interface TabProps {
  schedulerId: number;
  refreshMs: number;
}

/** 표 위의 데이터 기준 시각 (FR-VIEW-06). 대상 DB에서 읽은 시각이다 */
function DbTime({ dbNow }: { dbNow: number | undefined }) {
  return <p className="text-xs text-muted-foreground">대상 DB 시각 {formatDateTime(dbNow)} 기준</p>;
}

function useView<T>(
  schedulerId: number,
  view: string,
  path: string,
  refreshMs: number,
  query?: Query,
) {
  return useQuery({
    queryKey: schedulerViewKey(schedulerId, view, query),
    queryFn: ({ signal }) => api<T>(`/schedulers/${schedulerId}/${path}`, { query, signal }),
    refetchInterval: refreshMs || false,
    placeholderData: (prev) => prev,
  });
}

function LoadingRows({ columns }: { columns: number }) {
  return Array.from({ length: 3 }, (_, i) => (
    <TableRow key={i}>
      <TableCell colSpan={columns}>
        <Skeleton className="h-5 w-full" />
      </TableCell>
    </TableRow>
  ));
}

function EmptyRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={columns}>
        <span className="text-muted-foreground">{children}</span>
      </TableCell>
    </TableRow>
  );
}

// ── 노드 ───────────────────────────────────────────────

/** 클러스터 노드 (FR-VIEW-02) */
export function NodesTab({ schedulerId, refreshMs }: TabProps) {
  const res = useView<NodesResponse>(schedulerId, 'nodes', 'nodes', refreshMs);
  if (res.isError) return <FormAlert message={res.error.message} />;
  return (
    <div className="flex flex-col gap-2">
      <DbTime dbNow={res.data?.dbNow} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>인스턴스</TableHead>
            <TableHead>판정</TableHead>
            <TableHead>마지막 체크인</TableHead>
            <TableHead>체크인 간격</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!res.data ? (
            <LoadingRows columns={4} />
          ) : res.data.nodes.length === 0 ? (
            <EmptyRow columns={4}>
              체크인한 노드가 없습니다. 클러스터가 내려가 있을 수 있습니다.
            </EmptyRow>
          ) : (
            res.data.nodes.map((n) => (
              <TableRow key={n.instanceName}>
                <TableCell>
                  <span className="font-mono">{n.instanceName}</span>
                </TableCell>
                <TableCell>
                  {n.active ? (
                    <Badge variant="success">
                      <CircleCheckIcon data-icon="inline-start" aria-hidden />
                      활성
                    </Badge>
                  ) : (
                    <Badge
                      variant="warning"
                      title={`체크인 간격 × ${res.data.checkinMultiplier}을 넘겼습니다`}
                    >
                      <UnplugIcon data-icon="inline-start" aria-hidden />
                      체크인 지연
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex flex-col">
                    <TimeCell ms={n.lastCheckinTime} />
                    <span className="text-xs text-muted-foreground">
                      {formatAgo(n.sinceCheckinMs)}
                    </span>
                  </span>
                </TableCell>
                <TableCell>{formatInterval(n.checkinInterval)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// ── 일시정지 그룹 ────────────────────────────────────────

/** 일시정지된 트리거 그룹 (FR-VIEW-02) */
export function PausedGroupsTab({ schedulerId, refreshMs }: TabProps) {
  const res = useView<PausedGroupsResponse>(schedulerId, 'paused', 'paused-groups', refreshMs);
  if (res.isError) return <FormAlert message={res.error.message} />;
  if (!res.data) return <Skeleton className="h-16 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <DbTime dbNow={res.data.dbNow} />
      {res.data.allPaused ? (
        <Alert variant="warning">
          <PauseIcon aria-hidden />
          <AlertTitle>전체 일시정지(pauseAll) 상태입니다</AlertTitle>
          <AlertDescription>
            이 상태에서 새로 만드는 트리거 그룹도 일시정지된 채로 시작합니다.
          </AlertDescription>
        </Alert>
      ) : null}
      {res.data.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">일시정지된 트리거 그룹이 없습니다.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {res.data.groups.map((g) => (
            <li key={g}>
              <Badge variant="neutral">
                <PauseIcon data-icon="inline-start" aria-hidden />
                <span className="font-mono">{g}</span>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 잡 ────────────────────────────────────────────────

function SearchForm({
  group,
  q,
  onSubmit,
  qPlaceholder,
}: {
  group: string;
  q: string;
  onSubmit: (group: string, q: string) => void;
  qPlaceholder: string;
}) {
  const [g, setG] = useState(group);
  const [text, setText] = useState(q);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(g, text);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <Field className="w-56">
        <FieldLabel htmlFor={`${id}-group`}>그룹(정확히 일치)</FieldLabel>
        <Input id={`${id}-group`} value={g} onChange={(e) => setG(e.target.value)} />
      </Field>
      <Field className="w-64">
        <FieldLabel htmlFor={`${id}-q`}>검색어</FieldLabel>
        <Input
          id={`${id}-q`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={qPlaceholder}
        />
      </Field>
      <Button type="submit" variant="outline">
        <SearchIcon data-icon="inline-start" aria-hidden />
        검색하기
      </Button>
    </form>
  );
}

const PAGE_SIZE = 50;

/** 잡 목록 (FR-VIEW-03) */
export function JobsTab({ schedulerId, refreshMs }: TabProps) {
  const [filter, setFilter] = useState<Partial<JobListQuery>>({});
  const [page, setPage] = useState(1);
  const query: Query = { ...filter, page, size: PAGE_SIZE };
  const res = useView<Page<JobDto>>(schedulerId, 'jobs', 'jobs', refreshMs, query);
  const yesNo = (v: boolean | null) => (v === null ? '-' : v ? '예' : '아니요');

  return (
    <div className="flex flex-col gap-3">
      <SearchForm
        group={filter.group ?? ''}
        q={filter.q ?? ''}
        qPlaceholder="잡 이름, 그룹, 클래스"
        onSubmit={(group, q) => {
          setFilter({ group: group || undefined, q: q.trim() || undefined });
          setPage(1);
        }}
      />
      {res.isError ? <FormAlert message={res.error.message} /> : null}
      <DbTime dbNow={res.data?.dbNow} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>그룹 / 이름</TableHead>
            <TableHead>잡 클래스</TableHead>
            <TableHead>설명</TableHead>
            <TableHead>durable</TableHead>
            <TableHead>동시 실행 금지</TableHead>
            <TableHead>복구 요청</TableHead>
            <TableHead className="text-right">트리거</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!res.data ? (
            <LoadingRows columns={7} />
          ) : res.data.items.length === 0 ? (
            <EmptyRow columns={7}>조건에 맞는 잡이 없습니다.</EmptyRow>
          ) : (
            res.data.items.map((j) => (
              <TableRow key={`${j.group}\u0000${j.name}`}>
                <TableCell>
                  <Link
                    href={jobHref(schedulerId, j.group, j.name)}
                    className="flex flex-col underline-offset-4 hover:underline"
                  >
                    <span className="text-xs text-muted-foreground">{j.group}</span>
                    <span className="font-mono">{j.name}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{j.jobClass}</span>
                </TableCell>
                <TableCell>{j.description ?? '-'}</TableCell>
                <TableCell>{yesNo(j.durable)}</TableCell>
                <TableCell>{yesNo(j.nonConcurrent)}</TableCell>
                <TableCell>{yesNo(j.requestsRecovery)}</TableCell>
                <TableCell className="text-right">
                  <span className="tabular-nums">{j.triggerCount}</span>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {res.data ? (
        <PaginationBar page={page} size={PAGE_SIZE} total={res.data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}

// ── 트리거 ──────────────────────────────────────────────

/** 트리거 목록 (FR-VIEW-04). 상태·타입은 여러 개, 그룹은 정확히 일치, 검색어는 부분 일치 */
export function TriggersTab({ schedulerId, refreshMs }: TabProps) {
  const [states, setStates] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [text, setText] = useState<{ group?: string; q?: string }>({});
  const [sort, setSort] = useState<TriggerSort>('key');
  const [page, setPage] = useState(1);
  const query: Query & Partial<Record<keyof TriggerListQuery, unknown>> = {
    ...text,
    state: states.length ? states.join(',') : undefined,
    type: types.length ? types.join(',') : undefined,
    sort,
    page,
    size: PAGE_SIZE,
  };
  const res = useView<Page<TriggerDto>>(schedulerId, 'triggers', 'triggers', refreshMs, query);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">상태</span>
        <ToggleGroup
          type="multiple"
          variant="outline"
          value={states}
          onValueChange={(v) => {
            setStates(v);
            setPage(1);
          }}
          aria-label="상태 필터"
          className="flex-wrap"
        >
          {TRIGGER_STATES.filter((s) => s !== 'DELETED').map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {TRIGGER_STATE_META[s].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">타입</span>
        <ToggleGroup
          type="multiple"
          variant="outline"
          value={types}
          onValueChange={(v) => {
            setTypes(v);
            setPage(1);
          }}
          aria-label="타입 필터"
          className="flex-wrap"
        >
          {TRIGGER_TYPES.map((t) => (
            <ToggleGroupItem key={t} value={t}>
              {TRIGGER_TYPE_LABELS[t]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SearchForm
          group={text.group ?? ''}
          q={text.q ?? ''}
          qPlaceholder="트리거 이름, 그룹, 잡 이름"
          onSubmit={(group, q) => {
            setText({ group: group || undefined, q: q.trim() || undefined });
            setPage(1);
          }}
        />
        <Field className="w-44">
          <FieldLabel htmlFor="view-sort">정렬</FieldLabel>
          <Select value={sort} onValueChange={(v) => setSort(v as TriggerSort)}>
            <SelectTrigger id="view-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="key">그룹·이름 순</SelectItem>
              <SelectItem value="nextFireTime">다음 실행 시각 순</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {res.isError ? <FormAlert message={res.error.message} /> : null}
      <DbTime dbNow={res.data?.dbNow} />
      <TriggerTable schedulerId={schedulerId} triggers={res.data?.items} loading={res.isFetching} />
      {res.data ? (
        <PaginationBar page={page} size={PAGE_SIZE} total={res.data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}

// ── 실행 중 ─────────────────────────────────────────────

/** 실행 중이거나 획득된 트리거 (FR-VIEW-05). 활성 노드가 아닌 인스턴스의 기록은 구분해 보여 준다 */
export function ExecutingTab({ schedulerId, refreshMs }: TabProps) {
  const res = useView<ExecutingResponse>(schedulerId, 'executing', 'executing', refreshMs);
  if (res.isError) return <FormAlert message={res.error.message} />;
  const stale = res.data?.items.filter((e) => e.stale).length ?? 0;
  return (
    <div className="flex flex-col gap-3">
      {stale > 0 ? (
        <Alert variant="warning">
          <HistoryIcon aria-hidden />
          <AlertTitle>오래된 실행 기록 {stale}건</AlertTitle>
          <AlertDescription>
            활성 노드가 아닌 인스턴스의 기록입니다. 살아 있는 노드가 있으면 Quartz가 곧 복구하며
            정리합니다. 클러스터 전체가 내려간 경우에는 노드를 다시 띄우면 정리됩니다.
          </AlertDescription>
        </Alert>
      ) : null}
      <DbTime dbNow={res.data?.dbNow} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>트리거</TableHead>
            <TableHead>잡</TableHead>
            <TableHead>상태</TableHead>
            <TableHead>인스턴스</TableHead>
            <TableHead>실행 시각</TableHead>
            <TableHead>경과</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!res.data ? (
            <LoadingRows columns={6} />
          ) : res.data.items.length === 0 ? (
            <EmptyRow columns={6}>지금 실행 중이거나 획득된 트리거가 없습니다.</EmptyRow>
          ) : (
            res.data.items.map((e) => (
              <TableRow key={e.entryId}>
                <TableCell>
                  <span className="flex flex-col">
                    <span className="text-xs text-muted-foreground">{e.triggerGroup}</span>
                    <span className="font-mono">{e.triggerName}</span>
                  </span>
                </TableCell>
                <TableCell>
                  {e.jobGroup && e.jobName ? (
                    <Link
                      href={jobHref(schedulerId, e.jobGroup, e.jobName)}
                      className="flex flex-col underline-offset-4 hover:underline"
                    >
                      <span className="text-xs text-muted-foreground">{e.jobGroup}</span>
                      <span className="font-mono">{e.jobName}</span>
                    </Link>
                  ) : (
                    '-'
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    <TriggerStateBadge state={e.state} />
                    {e.stale ? (
                      <Badge variant="warning">
                        <HistoryIcon data-icon="inline-start" aria-hidden />
                        오래된 실행 기록
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="font-mono">{e.instanceName}</span>
                </TableCell>
                <TableCell>
                  <TimeCell ms={e.firedTime} />
                </TableCell>
                <TableCell>{e.elapsedMs === null ? '-' : formatInterval(e.elapsedMs)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
