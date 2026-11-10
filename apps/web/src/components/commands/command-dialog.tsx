'use client';

import {
  COMMAND_TARGETS_LISTED,
  commandScope,
  type CommandExpected,
  type CommandNoticeDto,
  type CommandPreviewResponse,
  type CommandResultDto,
  type QuartzCommand,
} from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, CircleAlertIcon, InfoIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { FormAlert } from '@/components/form/form-alert';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import { TriggerStateBadge } from '@/components/status/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { api, isApiError } from '@/lib/api';
import {
  commandConfirmLabel,
  commandResultMessage,
  commandTitle,
  summarizeChanges,
} from '@/lib/commands';
import { formatDateTime } from '@/lib/format';
import { schedulerKey } from '@/lib/schedulers';

/** 그룹·잡 명령이 무엇을 대상으로 하는지 (FR-CTL-00b) */
function ScopeLine({ command }: { command: QuartzCommand }) {
  switch (commandScope(command)) {
    case 'job':
      return 'job' in command ? (
        <span className="flex flex-col items-start gap-1">
          <span className="text-xs text-muted-foreground">잡 {command.job.group}</span>
          <span className="font-mono font-medium break-all">{command.job.name}</span>
        </span>
      ) : null;
    case 'triggerGroup':
    case 'jobGroup':
      return 'group' in command ? (
        <span className="flex flex-col items-start gap-1">
          <span className="text-xs text-muted-foreground">
            {commandScope(command) === 'triggerGroup' ? '트리거 그룹' : '잡 그룹'}
          </span>
          <span className="font-mono font-medium break-all">{command.group}</span>
        </span>
      ) : null;
    default:
      return null;
  }
}

/** 사유에 해당하는 트리거 키. 서버가 앞쪽 몇 개만 보낸다 */
function NoticeTriggers({ notice }: { notice: CommandNoticeDto }) {
  if (!notice.triggers?.length) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {notice.triggers.map((t) => (
        <li key={`${t.group}\u0000${t.name}`} className="font-mono text-xs break-all">
          {`${t.group} / ${t.name}`}
        </li>
      ))}
    </ul>
  );
}

function Summary({ data }: { data: CommandPreviewResponse }) {
  const { scheduler, targets, changes, groupChanges, inserts, command } = data;
  const single = commandScope(command) === 'trigger';
  const listed = targets.slice(0, COMMAND_TARGETS_LISTED);
  return (
    <dl className="grid grid-cols-4 gap-x-4 gap-y-3 text-sm">
      <dt className="text-muted-foreground">스케줄러</dt>
      <dd className="col-span-3 flex flex-col items-start gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{scheduler.displayName}</span>
          <EnvBadge environment={scheduler.envLabel} />
        </span>
        <span className="text-xs text-muted-foreground">
          접속 {scheduler.connectionName} · <span className="font-mono">{scheduler.schedName}</span>
        </span>
      </dd>
      <dt className="text-muted-foreground">대상</dt>
      <dd className="col-span-3 flex flex-col gap-2">
        <ScopeLine command={command} />
        {single || command.type === 'triggerJob' ? null : <span>트리거 {targets.length}개</span>}
        {listed.map((t) => (
          <span key={`${t.group}\u0000${t.name}`} className="flex flex-col items-start gap-1">
            <span className="text-xs text-muted-foreground">{t.group}</span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono break-all">{t.name}</span>
              <TriggerStateBadge state={t.state} />
            </span>
            {single ? (
              <span className="text-xs text-muted-foreground">
                잡 <span className="font-mono break-all">{`${t.jobGroup} / ${t.jobName}`}</span>
              </span>
            ) : null}
          </span>
        ))}
        {targets.length > listed.length ? (
          <span className="text-xs text-muted-foreground">
            외 {targets.length - listed.length}개
          </span>
        ) : null}
      </dd>
      <dt className="text-muted-foreground">영향 범위</dt>
      <dd className="col-span-3 flex flex-col gap-2">
        {inserts.map((ins) => (
          <span
            key={`${ins.group}\u0000${ins.name ?? ''}`}
            className="flex flex-col items-start gap-1"
          >
            <span>{ins.group} 그룹에 한 번 실행할 트리거를 넣습니다</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              넣을 때 상태 <TriggerStateBadge state={ins.state} />
            </span>
          </span>
        ))}
        {inserts.length > 0 && changes.length === 0 ? null : (
          <span>
            {changes.length > 0
              ? `트리거 ${changes.length}개의 상태가 바뀝니다`
              : '상태가 바뀌는 트리거가 없습니다'}
          </span>
        )}
        {summarizeChanges(changes).map((c) => (
          <span key={`${c.from}\u0000${c.to}`} className="flex flex-wrap items-center gap-2">
            <TriggerStateBadge state={c.from} />
            <ArrowRightIcon className="size-4 text-muted-foreground" aria-label="에서" />
            <TriggerStateBadge state={c.to} />
            {single ? null : (
              <span className="text-muted-foreground tabular-nums">{c.count}개</span>
            )}
          </span>
        ))}
        {groupChanges.map((g) => (
          <span key={g.group}>
            {g.paused
              ? `${g.group} 그룹을 일시정지 상태로 기록합니다. 나중에 이 그룹에 추가되는 트리거도 일시정지됩니다`
              : `${g.group} 그룹의 일시정지 기록을 지웁니다`}
          </span>
        ))}
      </dd>
    </dl>
  );
}

/**
 * 제어 명령 확인 대화상자 (FR-CTL-00b). 열 때마다 미리보기를 새로 읽어 대상(스케줄러, 그룹, 이름), 환경,
 * 영향 범위를 보여 주고, 미리보기의 기대 상태를 붙여 실행한다. 확인 절차는 환경과 관계없이 같고
 * prod는 맨 위 빨간 띠로 구분한다(NFR-UX-02).
 *
 * 실행 직전 상태가 미리보기와 다르면(409 `STATE_CONFLICT`) 실행하지 않고 미리보기를 다시 읽어 최신 상태를 보여 준다
 * (FR-CTL-00e). 성공하면 결과를 알리고 스케줄러 화면의 조회를 모두 새로 읽는다(NFR-UX-03).
 */
export function CommandDialog({
  schedulerId,
  command,
  open,
  onClose,
  returnFocus,
}: {
  schedulerId: number;
  command: QuartzCommand;
  open: boolean;
  onClose: () => void;
  /** 닫힌 뒤 포커스를 돌려줄 요소. 메뉴 항목으로 열기 때문에 직접 알려 준다 */
  returnFocus?: () => HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  /** 직전 실행이 상태 충돌로 멈췄는지. 다시 실행하면 지운다 */
  const [conflict, setConflict] = useState(false);

  const preview = useQuery({
    queryKey: ['command-preview', schedulerId, command],
    queryFn: ({ signal }) =>
      api<CommandPreviewResponse>(`/schedulers/${schedulerId}/commands/preview`, {
        method: 'POST',
        body: { command },
        signal,
      }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const refreshScheduler = () =>
    void queryClient.invalidateQueries({ queryKey: schedulerKey(schedulerId) });

  const run = useMutation({
    mutationFn: (expected: CommandExpected) =>
      api<CommandResultDto>(`/schedulers/${schedulerId}/commands`, {
        method: 'POST',
        body: { command, expected },
      }),
    onMutate: () => setConflict(false),
    onSuccess: (result) => {
      if (result.changed) toast.success(commandResultMessage(result));
      else toast.info(commandResultMessage(result));
      refreshScheduler();
      onClose();
    },
    onError: (err) => {
      if (isApiError(err, 'STATE_CONFLICT')) {
        setConflict(true);
        void preview.refetch();
        refreshScheduler();
      }
    },
  });

  const data = preview.data;
  const loading = preview.isFetching;
  const blocked = data?.blocked ?? null;
  const canRun = !!data && !blocked && !loading && !run.isPending;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !run.isPending && onClose()}>
      <AlertDialogContent
        onCloseAutoFocus={(e) => {
          const target = returnFocus?.();
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        {data ? (
          <div className="-mx-6 -mt-6 overflow-hidden rounded-t-xl empty:hidden">
            <ProdStripe environment={data.scheduler.envLabel} name={data.scheduler.displayName} />
          </div>
        ) : null}
        <AlertDialogHeader>
          <AlertDialogTitle>{commandTitle(command)}</AlertDialogTitle>
          <AlertDialogDescription>
            대상과 영향 범위를 확인한 뒤 실행하세요. 실행 직전에 대상 상태를 다시 확인하고, 이
            화면과 다르면 실행하지 않습니다.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {preview.isError ? <FormAlert error={preview.error} /> : null}
        {preview.isPending && !preview.isError ? <Skeleton className="h-40 w-full" /> : null}
        {data ? (
          <div className="flex flex-col gap-4">
            <Summary data={data} />
            <p className="text-xs text-muted-foreground">
              대상 DB 시각 {formatDateTime(data.dbNow)} 기준
            </p>
            {blocked ? (
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden />
                <AlertTitle>실행할 수 없습니다</AlertTitle>
                <AlertDescription>
                  {blocked.message}
                  <NoticeTriggers notice={blocked} />
                </AlertDescription>
              </Alert>
            ) : null}
            {data.warnings.map((w) => (
              <Alert key={w.code}>
                <InfoIcon aria-hidden />
                <AlertDescription>
                  {w.message}
                  <NoticeTriggers notice={w} />
                </AlertDescription>
              </Alert>
            ))}
          </div>
        ) : null}
        {conflict ? (
          <Alert variant="warning">
            <RefreshCwIcon aria-hidden />
            <AlertTitle>상태가 바뀌어 실행하지 않았습니다</AlertTitle>
            <AlertDescription>
              위 내용을 최신 상태로 다시 읽었습니다. 확인한 뒤 다시 실행하세요.
            </AlertDescription>
          </Alert>
        ) : null}
        {run.isError && !conflict ? <FormAlert error={run.error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={run.isPending}>취소</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canRun}
            onClick={(e) => {
              e.preventDefault();
              if (data) run.mutate(data.expected);
            }}
          >
            {run.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
            {commandConfirmLabel(command)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
