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
import {
  ActivityIcon,
  BriefcaseIcon,
  CircleCheckIcon,
  HistoryIcon,
  PauseIcon,
  SearchIcon,
  SearchXIcon,
  ServerIcon,
  TimerIcon,
  UnplugIcon,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';

import { useCommandDialog } from '@/components/commands/use-command-dialog';
import { FormAlert } from '@/components/form/form-alert';
import { LinkRow, RowChevronCell, RowChevronHead, RowLink } from '@/components/links';
import { TableEmpty } from '@/components/table-empty';
import { TableFrame } from '@/components/table-frame';
import { PaginationBar } from '@/components/schedulers/pagination-bar';
import { TimeCell } from '@/components/schedulers/time-cell';
import { TriggerActions } from '@/components/schedulers/trigger-actions';
import { JobLink, jobHref, TriggerTable } from '@/components/schedulers/trigger-table';
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
  SelectGroup,
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
import { useSlashFocus } from '@/hooks/use-slash-focus';
import { api, type Query } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatAgo, formatInterval, schedulerViewKey, TRIGGER_TYPE_LABELS } from '@/lib/schedulers';
import { parsePage, setParam, type UrlCodec, useUrlState } from '@/lib/use-url-state';

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

// ── 노드 ───────────────────────────────────────────────

/** 클러스터 노드 (FR-VIEW-02) */
export function NodesTab({ schedulerId, refreshMs }: TabProps) {
  const res = useView<NodesResponse>(schedulerId, 'nodes', 'nodes', refreshMs);
  if (res.isError) return <FormAlert error={res.error} />;
  return (
    <div className="flex flex-col gap-2">
      <DbTime dbNow={res.data?.dbNow} />
      <TableFrame>
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
              <TableEmpty
                colSpan={4}
                icon={ServerIcon}
                title="체크인한 노드가 없습니다"
                description="클러스터가 내려가 있을 수 있습니다."
              />
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
      </TableFrame>
    </div>
  );
}

// ── 일시정지 그룹 ────────────────────────────────────────

/** 일시정지된 트리거 그룹 (FR-VIEW-02) */
export function PausedGroupsTab({ schedulerId, refreshMs }: TabProps) {
  const res = useView<PausedGroupsResponse>(schedulerId, 'paused', 'paused-groups', refreshMs);
  if (res.isError) return <FormAlert error={res.error} />;
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
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>일시정지된 트리거 그룹 ({res.data.groups.length})</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {res.data.groups.map((g) => (
                <TableRow key={g}>
                  <TableCell>
                    <span className="font-mono">{g}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </div>
  );
}

// ── 잡 ────────────────────────────────────────────────

/** 목록 위 필터 묶음. 표와 구분되도록 한 면에 모은다 */
function FilterPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-xs">
      {children}
    </div>
  );
}

function SearchForm({
  group,
  q,
  onSubmit,
  qScope,
}: {
  group: string;
  q: string;
  onSubmit: (group: string, q: string) => void;
  /** 검색어가 걸리는 컬럼. 라벨에 함께 쓴다(placeholder는 형식 예시에만 쓴다) */
  qScope: string;
}) {
  const [g, setG] = useState(group);
  const [text, setText] = useState(q);
  const id = useId();
  const qRef = useRef<HTMLInputElement>(null);
  useSlashFocus(qRef);
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
        <FieldLabel htmlFor={`${id}-q`}>검색어({qScope})</FieldLabel>
        <Input
          ref={qRef}
          id={`${id}-q`}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-keyshortcuts="/"
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

interface JobsView {
  group?: string;
  q?: string;
  page: number;
}

/** 잡 탭 상태 ↔ 주소(`group`, `q`, `page`). 잡 상세에 갔다 돌아와도 그대로다(B-40) */
const JOBS_CODEC: UrlCodec<JobsView> = {
  parse: (p) => ({
    group: p.get('group') || undefined,
    q: p.get('q') || undefined,
    page: parsePage(p.get('page')),
  }),
  write: (v, p) => {
    setParam(p, 'group', v.group);
    setParam(p, 'q', v.q);
    setParam(p, 'page', String(v.page), '1');
  },
};

/** 잡 목록 (FR-VIEW-03) */
export function JobsTab({ schedulerId, refreshMs }: TabProps) {
  const [view, setView] = useUrlState(JOBS_CODEC);
  const filter: Partial<JobListQuery> = { group: view.group, q: view.q };
  const page = view.page;
  const setFilter = (f: Partial<JobListQuery>) =>
    setView((v) => ({ ...v, group: f.group, q: f.q }));
  const setPage = (p: number) => setView((v) => ({ ...v, page: p }));
  const query: Query = { ...filter, page, size: PAGE_SIZE };
  const res = useView<Page<JobDto>>(schedulerId, 'jobs', 'jobs', refreshMs, query);
  const yesNo = (v: boolean | null) => (v === null ? '-' : v ? '예' : '아니요');

  return (
    <div className="flex flex-col gap-3">
      <FilterPanel>
        <SearchForm
          key={JSON.stringify(filter)}
          group={filter.group ?? ''}
          q={filter.q ?? ''}
          qScope="이름·그룹·클래스"
          onSubmit={(group, q) => {
            setFilter({ group: group || undefined, q: q.trim() || undefined });
            setPage(1);
          }}
        />
      </FilterPanel>
      {res.isError ? <FormAlert error={res.error} /> : null}
      <DbTime dbNow={res.data?.dbNow} />
      <TableFrame>
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
              <RowChevronHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!res.data ? (
              <LoadingRows columns={8} />
            ) : res.data.items.length === 0 ? (
              filter.group || filter.q ? (
                <TableEmpty
                  colSpan={8}
                  icon={SearchXIcon}
                  title="조건에 맞는 잡이 없습니다"
                  action={
                    <Button variant="outline" onClick={() => setFilter({})}>
                      필터 모두 지우기
                    </Button>
                  }
                />
              ) : (
                <TableEmpty colSpan={8} icon={BriefcaseIcon} title="등록된 잡이 없습니다" />
              )
            ) : (
              res.data.items.map((j) => (
                <LinkRow key={`${j.group}\u0000${j.name}`}>
                  <TableCell>
                    <span className="flex flex-col">
                      <span className="text-xs text-muted-foreground">{j.group}</span>
                      <RowLink href={jobHref(schedulerId, j.group, j.name)} className="font-mono">
                        {j.name}
                      </RowLink>
                    </span>
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
                  <RowChevronCell />
                </LinkRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableFrame>
      {res.data ? (
        <PaginationBar page={page} size={PAGE_SIZE} total={res.data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}

// ── 트리거 ──────────────────────────────────────────────

interface TriggersView {
  states: string[];
  types: string[];
  group?: string;
  q?: string;
  sort: TriggerSort;
  page: number;
}

/** 쉼표로 이은 값 중 허용 목록에 있는 것만 */
function parseList(raw: string | null, allowed: readonly string[]): string[] {
  return raw ? raw.split(',').filter((v) => allowed.includes(v)) : [];
}

/** 트리거 탭 상태 ↔ 주소(`state`, `type`, `group`, `q`, `sort`, `page`) (B-40) */
const TRIGGERS_CODEC: UrlCodec<TriggersView> = {
  parse: (p) => ({
    states: parseList(p.get('state'), TRIGGER_STATES),
    types: parseList(p.get('type'), TRIGGER_TYPES),
    group: p.get('group') || undefined,
    q: p.get('q') || undefined,
    sort: p.get('sort') === 'nextFireTime' ? 'nextFireTime' : 'key',
    page: parsePage(p.get('page')),
  }),
  write: (v, p) => {
    setParam(p, 'state', v.states.join(','));
    setParam(p, 'type', v.types.join(','));
    setParam(p, 'group', v.group);
    setParam(p, 'q', v.q);
    setParam(p, 'sort', v.sort, 'key');
    setParam(p, 'page', String(v.page), '1');
  },
};

/** 트리거 목록 (FR-VIEW-04). 상태·타입은 여러 개, 그룹은 정확히 일치, 검색어는 부분 일치 */
export function TriggersTab({
  schedulerId,
  refreshMs,
  blockedReason,
}: TabProps & {
  /** 제어할 수 없는 이유(읽기 전용 접속 등). 있으면 줄 메뉴의 제어 항목을 끈다 */
  blockedReason: string | null;
}) {
  const { openCommand, dialog } = useCommandDialog(schedulerId);
  const [view, setView] = useUrlState(TRIGGERS_CODEC);
  const { states, types, sort, page } = view;
  const text = { group: view.group, q: view.q };
  const update = (patch: Partial<TriggersView>) => setView((v) => ({ ...v, ...patch }));
  const setStates = (v: string[]) => update({ states: v });
  const setTypes = (v: string[]) => update({ types: v });
  const setText = (v: { group?: string; q?: string }) => update({ group: v.group, q: v.q });
  const setSort = (v: TriggerSort) => update({ sort: v });
  const setPage = (v: number) => update({ page: v });
  const query: Query & Partial<Record<keyof TriggerListQuery, unknown>> = {
    ...text,
    state: states.length ? states.join(',') : undefined,
    type: types.length ? types.join(',') : undefined,
    sort,
    page,
    size: PAGE_SIZE,
  };
  const res = useView<Page<TriggerDto>>(schedulerId, 'triggers', 'triggers', refreshMs, query);
  const filtered = states.length > 0 || types.length > 0 || !!text.group || !!text.q;
  const clearFilters = () =>
    update({ states: [], types: [], group: undefined, q: undefined, page: 1 });

  return (
    <div className="flex flex-col gap-3">
      <FilterPanel>
        <div className="flex flex-wrap gap-x-8 gap-y-4">
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
              {TRIGGER_STATES.filter((s) => s !== 'DELETED').map((s) => {
                const meta = TRIGGER_STATE_META[s];
                return (
                  <ToggleGroupItem key={s} value={s}>
                    <meta.icon data-icon="inline-start" aria-hidden />
                    {meta.label}
                  </ToggleGroupItem>
                );
              })}
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
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SearchForm
            key={JSON.stringify(text)}
            group={text.group ?? ''}
            q={text.q ?? ''}
            qScope="이름·그룹·잡"
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
                <SelectGroup>
                  <SelectItem value="key">그룹·이름 순</SelectItem>
                  <SelectItem value="nextFireTime">다음 실행 시각 순</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {filtered ? (
            <Button variant="ghost" onClick={clearFilters}>
              필터 모두 지우기
            </Button>
          ) : null}
        </div>
      </FilterPanel>
      {res.isError ? <FormAlert error={res.error} /> : null}
      <DbTime dbNow={res.data?.dbNow} />
      <TableFrame>
        <TriggerTable
          schedulerId={schedulerId}
          triggers={res.data?.items}
          loading={res.isFetching}
          empty={
            filtered
              ? {
                  icon: SearchXIcon,
                  title: '조건에 맞는 트리거가 없습니다',
                  action: (
                    <Button variant="outline" onClick={clearFilters}>
                      필터 모두 지우기
                    </Button>
                  ),
                }
              : { icon: TimerIcon, title: '등록된 트리거가 없습니다' }
          }
          actions={(t) => (
            <TriggerActions trigger={t} blockedReason={blockedReason} onCommand={openCommand} />
          )}
        />
      </TableFrame>
      {res.data ? (
        <PaginationBar page={page} size={PAGE_SIZE} total={res.data.total} onPageChange={setPage} />
      ) : null}
      {dialog}
    </div>
  );
}

// ── 실행 중 ─────────────────────────────────────────────

/** 실행 중이거나 획득된 트리거 (FR-VIEW-05). 활성 노드가 아닌 인스턴스의 기록은 구분해 보여 준다 */
export function ExecutingTab({ schedulerId, refreshMs }: TabProps) {
  const res = useView<ExecutingResponse>(schedulerId, 'executing', 'executing', refreshMs);
  if (res.isError) return <FormAlert error={res.error} />;
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
      <TableFrame>
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
              <TableEmpty
                colSpan={6}
                icon={ActivityIcon}
                title="지금 실행 중이거나 획득된 트리거가 없습니다"
              />
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
                      <JobLink schedulerId={schedulerId} group={e.jobGroup} name={e.jobName} />
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
      </TableFrame>
    </div>
  );
}
