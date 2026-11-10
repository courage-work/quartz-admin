'use client';

import type { ConnectionDto, DetectionDto, SchedulerDto } from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MoreHorizontalIcon,
  PencilIcon,
  Settings2Icon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ConnectionNotFound } from '@/components/connections/connection-not-found';
import { DeleteImpactDialog } from '@/components/connections/delete-impact-dialog';
import { DetectionPanel } from '@/components/connections/detection-panel';
import { WriteStatusBadge } from '@/components/connections/write-status-badge';
import { FormAlert } from '@/components/form/form-alert';
import { InlineLink } from '@/components/links';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, isApiError } from '@/lib/api';
import {
  BOOL_FORMAT_LABELS,
  CONNECTIONS_KEY,
  connectionKey,
  connectionSchedulersKey,
  DB_KIND_LABELS,
  describeAddress,
  formatDuration,
} from '@/lib/connections';
import { formatDateTime } from '@/lib/format';
import { parseId } from '@/lib/navigation';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="md:col-span-3">{children}</dd>
    </>
  );
}

/** 수정 화면(`ConnectionForm`)과 같은 카드 나눔·순서·라벨 칸(1/4)을 쓴다 (B-40) */
function InfoCards({ connection }: { connection: ConnectionDto }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>접속 정보</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-4">
            <Row label="DB 종류">{DB_KIND_LABELS[connection.dbType]}</Row>
            <Row label="주소">
              <span className="font-mono">{describeAddress(connection)}</span>
            </Row>
            <Row label="스키마">
              {connection.schemaName ? (
                <span className="font-mono">{connection.schemaName}</span>
              ) : (
                <span className="text-muted-foreground">계정 기본 스키마</span>
              )}
            </Row>
            <Row label="계정">
              <span className="font-mono">{connection.username}</span>
            </Row>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>표시와 권한</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-4">
            <Row label="접속 이름">{connection.name}</Row>
            <Row label="환경 라벨">
              <EnvBadge environment={connection.envLabel} />
            </Row>
            <Row label="태그">
              {connection.tags.length === 0 ? '-' : connection.tags.join(' · ')}
            </Row>
            <Row label="권한">
              <WriteStatusBadge connection={connection} />
            </Row>
            <Row label="수정한 시각">{formatDateTime(connection.updatedAt)}</Row>
          </dl>
        </CardContent>
      </Card>
    </>
  );
}

function SchedulersCard({
  schedulers,
  missingIds,
  onDelete,
}: {
  schedulers: SchedulerDto[] | undefined;
  missingIds: number[];
  onDelete: (s: SchedulerDto) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>등록한 스케줄러</CardTitle>
        <CardDescription>감시 주기마다 상태를 읽고, 대시보드와 알림에 나타납니다.</CardDescription>
      </CardHeader>
      <CardContent>
        {schedulers === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : schedulers.length === 0 ? (
          // 다음 할 일(감지한 후보 등록)이 바로 아래 카드에 있어, 큰 빈 표시 대신 한 줄로 알린다
          <p className="text-sm text-muted-foreground">
            아직 등록한 스케줄러가 없습니다. 아래에서 감지한 후보를 골라 등록하세요.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>표시 이름</TableHead>
                <TableHead>SCHED_NAME</TableHead>
                <TableHead>prefix</TableHead>
                <TableHead>불리언</TableHead>
                <TableHead className="text-right">기대 노드</TableHead>
                <TableHead>감시 주기</TableHead>
                <TableHead>감지한 시각</TableHead>
                <TableHead>
                  <span className="sr-only">관리</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedulers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <InlineLink href={`/scheduler?id=${s.id}`}>{s.displayName}</InlineLink>
                      {missingIds.includes(s.id) ? (
                        <Badge variant="warning">
                          <TriangleAlertIcon data-icon="inline-start" aria-hidden />
                          최근 감지에서 찾지 못함
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">{s.schedName}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">{s.tablePrefix || '-'}</span>
                  </TableCell>
                  <TableCell>{BOOL_FORMAT_LABELS[s.boolFormat]}</TableCell>
                  <TableCell className="text-right">
                    <span className="tabular-nums">{s.expectedNodeCount}</span>
                  </TableCell>
                  <TableCell>{formatDuration(s.pollIntervalSec * 1000)}</TableCell>
                  <TableCell>{formatDateTime(s.detectedAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`${s.displayName} 관리하기`}
                                data-menu-for={s.id}
                              >
                                <MoreHorizontalIcon aria-hidden />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>{s.displayName} 관리하기</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/scheduler/settings?id=${s.id}`}>
                              <Settings2Icon aria-hidden />
                              설정
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(s)}>
                            <Trash2Icon aria-hidden />
                            등록 해제
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** 접속 상세 (`/connection?id=N`). 스케줄러 감지·등록·설정·해제와 접속 수정·삭제 (FR-CON-03~07) */
export function ConnectionView() {
  const params = useSearchParams();
  const id = parseId(params.get('id'));
  const autoDetect = params.get('detect') === '1';
  const router = useRouter();
  const queryClient = useQueryClient();
  const [unregistering, setUnregistering] = useState<SchedulerDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const connection = useQuery({
    queryKey: connectionKey(id ?? 0),
    queryFn: ({ signal }) => api<ConnectionDto>(`/connections/${id}`, { signal }),
    enabled: id !== null,
  });
  const schedulers = useQuery({
    queryKey: connectionSchedulersKey(id ?? 0),
    queryFn: ({ signal }) => api<SchedulerDto[]>(`/connections/${id}/schedulers`, { signal }),
    enabled: id !== null && connection.isSuccess,
  });

  const detect = useMutation({
    mutationFn: () => api<DetectionDto>(`/connections/${id}/detect`, { method: 'POST' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
  });

  // 새로 만든 접속(`&detect=1`)은 화면을 열자마자 한 번 감지한다
  const autoDetected = useRef(false);
  useEffect(() => {
    if (autoDetect && id !== null && connection.isSuccess && !autoDetected.current) {
      autoDetected.current = true;
      detect.mutate();
    }
  }, [autoDetect, id, connection.isSuccess, detect]);

  const unregister = useMutation({
    mutationFn: (s: SchedulerDto) => api<void>(`/schedulers/${s.id}`, { method: 'DELETE' }),
    onSuccess: (_, s) => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success(`${s.displayName} 스케줄러 등록을 해제했습니다`);
      setUnregistering(null);
      if (detect.data) detect.mutate();
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api<void>(`/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: connectionKey(id ?? 0) });
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success(`${connection.data?.name ?? ''} 접속을 삭제했습니다`);
      router.push('/connections');
    },
    onError: (err) => toast.error(err.message),
  });

  // 아직 못 읽었거나 읽지 못했어도 화면 머리(경로, 돌아가기)는 남긴다
  if (connection.isError || connection.isPending) {
    return (
      <>
        <PageHeader trail={[{ label: '접속', href: '/connections' }]} title="접속" />
        {id === null || isApiError(connection.error, 'NOT_FOUND') ? (
          <ConnectionNotFound />
        ) : connection.isError ? (
          <FormAlert error={connection.error} />
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </>
    );
  }
  const conn = connection.data;

  const detectError = isApiError(detect.error)
    ? { code: detect.error.code, message: detect.error.message }
    : detect.error
      ? { code: 'INTERNAL_ERROR', message: detect.error.message }
      : null;

  return (
    <>
      <ProdStripe environment={conn.envLabel} name={conn.name} />
      <PageHeader
        trail={[{ label: '접속', href: '/connections' }]}
        title={conn.name}
        description={<EnvBadge environment={conn.envLabel} />}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`/connection/edit?id=${conn.id}`}>
                <PencilIcon data-icon="inline-start" aria-hidden />
                수정하기
              </Link>
            </Button>
            {/* 삭제는 메뉴의 "등록 해제", 확인 대화상자의 버튼과 같은 destructive 모양으로 구분한다 */}
            <Button variant="destructive" data-delete-connection onClick={() => setDeleting(true)}>
              <Trash2Icon data-icon="inline-start" aria-hidden />
              삭제하기
            </Button>
          </>
        }
      />
      <InfoCards connection={conn} />
      <SchedulersCard
        schedulers={schedulers.data}
        missingIds={detect.data?.missingSchedulerIds ?? []}
        onDelete={setUnregistering}
      />
      <DetectionPanel
        connectionId={conn.id}
        detection={detect.data}
        detecting={detect.isPending}
        detectError={detectError}
        onDetect={() => detect.mutate()}
      />

      <DeleteImpactDialog
        open={unregistering !== null}
        title={`${unregistering?.displayName ?? ''} 스케줄러 등록을 해제할까요?`}
        description="도구에서만 지웁니다. 대상 DB의 Quartz 잡과 트리거는 그대로 남고, 다시 감지해 등록할 수 있습니다."
        impactPath={`/schedulers/${unregistering?.id ?? 0}/delete-impact`}
        confirmLabel="등록 해제하기"
        pending={unregister.isPending}
        onConfirm={() => unregistering && unregister.mutate(unregistering)}
        onClose={() => setUnregistering(null)}
        returnFocus={() =>
          unregistering
            ? document.querySelector<HTMLElement>(`[data-menu-for="${unregistering.id}"]`)
            : null
        }
      />
      <DeleteImpactDialog
        open={deleting}
        title={`${conn.name} 접속을 삭제할까요?`}
        description="도구에서만 지웁니다. 대상 DB의 Quartz 데이터는 그대로 남습니다. 지운 접속은 되돌릴 수 없습니다."
        impactPath={`/connections/${conn.id}/delete-impact`}
        confirmLabel={`${conn.name} 삭제하기`}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleting(false)}
        returnFocus={() => document.querySelector<HTMLElement>('[data-delete-connection]')}
      />
    </>
  );
}
