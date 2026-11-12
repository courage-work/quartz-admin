'use client';

import type {
  BatchPreviewItemDto,
  BatchPreviewResponse,
  BatchResultItemDto,
  BatchResultResponse,
} from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  CircleAlertIcon,
  InfoIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import {
  type BatchAction,
  type BatchKey,
  type BatchKind,
  batchCommand,
  batchCommandKey,
  batchConfirmLabel,
  batchKeyId,
  batchRequest,
  batchResultMessage,
  batchTitle,
  classifyPreviewItem,
  classifyResultItem,
  countPreview,
  countResult,
  hasMisfireWarning,
  previewItemReason,
} from '@/lib/batch';
import { formatDateTime } from '@/lib/format';
import { summarizeChanges } from '@/lib/commands';
import { schedulerKey } from '@/lib/schedulers';

/** 항목의 그룹(위, 옅게)과 이름 */
function KeyLabel({ itemKey }: { itemKey: BatchKey }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-xs break-all text-muted-foreground">{itemKey.group}</span>
      <span className="font-mono break-all">{itemKey.name}</span>
    </span>
  );
}

/** 미리보기 항목 한 줄: 대상과 바뀔 상태, 또는 실행하지 않는 이유 */
function PreviewRow({ kind, item }: { kind: BatchKind; item: BatchPreviewItemDto }) {
  const cls = classifyPreviewItem(item);
  const p = item.preview;
  return (
    <li className="flex flex-col gap-1 py-2">
      <KeyLabel itemKey={batchCommandKey(item.command)} />
      {cls === 'blocked' ? (
        <span className="text-xs text-destructive">{previewItemReason(item)}</span>
      ) : cls === 'noChange' ? (
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {kind === 'trigger' && p?.targets[0] ? (
            <TriggerStateBadge state={p.targets[0].state} />
          ) : null}
          바뀌는 것이 없어 실행하지 않습니다
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          {summarizeChanges(p?.changes ?? []).map((c) => (
            <span key={`${c.from}\u0000${c.to}`} className="flex items-center gap-2">
              <TriggerStateBadge state={c.from} />
              <ArrowRightIcon className="size-4 text-muted-foreground" aria-label="에서" />
              <TriggerStateBadge state={c.to} />
              {kind === 'job' ? (
                <span className="text-muted-foreground tabular-nums">{c.count}개</span>
              ) : null}
            </span>
          ))}
        </span>
      )}
    </li>
  );
}

/** 실행하지 못한 항목 한 줄 */
function FailedRow({ item }: { item: BatchResultItemDto }) {
  const skipped = classifyResultItem(item) === 'skipped';
  return (
    <li className="flex flex-col gap-1 py-2">
      <span className="flex items-start justify-between gap-2">
        <KeyLabel itemKey={batchCommandKey(item.command)} />
        <Badge variant={skipped ? 'neutral' : 'destructive'}>{skipped ? '건너뜀' : '실패'}</Badge>
      </span>
      {'error' in item ? (
        <span className="text-xs text-muted-foreground">
          {item.error.message} <span className="font-mono">({item.error.code})</span>
        </span>
      ) : null}
    </li>
  );
}

const countText = (parts: [number, string][]) =>
  parts
    .filter(([n], i) => i === 0 || n > 0)
    .map(([n, label]) => `${label} ${n}개`)
    .join(' · ');

/**
 * 일괄 제어 확인 대화상자 (FR-CTL-10). 열 때 고른 항목마다 미리보기를 읽어 바뀔 상태와 실행하지 않을 항목(이유)을 보여 주고,
 * 바뀌는 것이 있는 항목만 실행한다. 서버는 항목마다 따로 실행·기록하고 한 항목이 실패해도 다음 항목을 실행한다.
 * 모두 성공하면 닫고 알림으로 알리며, 실패한 항목이 있으면 대화상자에 그 항목과 원인을 남긴다.
 */
export function BatchDialog({
  schedulerId,
  kind,
  action,
  keys,
  open,
  onClose,
  onDone,
}: {
  schedulerId: number;
  kind: BatchKind;
  action: BatchAction;
  keys: readonly BatchKey[];
  open: boolean;
  onClose: () => void;
  /** 실행을 마친 뒤 할 일(선택 해제) */
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const commands = keys.map((k) => batchCommand(kind, action, k));
  const [result, setResult] = useState<BatchResultResponse | null>(null);

  const preview = useQuery({
    queryKey: ['batch-preview', schedulerId, commands],
    queryFn: ({ signal }) =>
      api<BatchPreviewResponse>(`/schedulers/${schedulerId}/commands/batch/preview`, {
        method: 'POST',
        body: { commands },
        signal,
      }),
    enabled: open && result === null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const run = useMutation({
    mutationFn: (data: BatchPreviewResponse) =>
      api<BatchResultResponse>(`/schedulers/${schedulerId}/commands/batch`, {
        method: 'POST',
        body: batchRequest(data.items),
      }),
    onSuccess: (res) => {
      const c = countResult(res.items);
      const message = batchResultMessage(kind, action, res.items);
      void queryClient.invalidateQueries({ queryKey: schedulerKey(schedulerId) });
      onDone?.();
      if (c.failure + c.skipped > 0) {
        toast.warning(message);
        setResult(res);
        return;
      }
      if (c.changed > 0) toast.success(message);
      else toast.info(message);
      onClose();
    },
  });

  const data = preview.data;
  const counts = data ? countPreview(data.items) : null;
  const canRun =
    !!data && !data.blocked && (counts?.run ?? 0) > 0 && !preview.isFetching && !run.isPending;
  const failed = result?.items.filter((it) => it.status !== 'success') ?? [];
  const resultCounts = result ? countResult(result.items) : null;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !run.isPending && onClose()}>
      <AlertDialogContent>
        {data ? (
          <div className="-mx-6 -mt-6 overflow-hidden rounded-t-xl empty:hidden">
            <ProdStripe environment={data.scheduler.envLabel} name={data.scheduler.displayName} />
          </div>
        ) : null}
        <AlertDialogHeader>
          <AlertDialogTitle>
            {result && resultCounts
              ? resultCounts.changed + resultCounts.unchanged > 0
                ? '일부 항목을 실행하지 못했습니다'
                : '항목을 실행하지 못했습니다'
              : batchTitle(kind, action, keys.length)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {result
              ? '실행하지 못한 항목과 원인을 확인하세요. 실행한 항목과 실패한 항목은 감사 로그에 남았습니다.'
              : '항목마다 실행 직전에 대상 상태를 다시 확인하고, 이 화면과 다르면 그 항목만 실행하지 않습니다.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {preview.isError ? <FormAlert error={preview.error} /> : null}
        {preview.isPending && !preview.isError && !result ? (
          <Skeleton className="h-40 w-full" />
        ) : null}

        {data ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-col items-start gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{data.scheduler.displayName}</span>
                <EnvBadge environment={data.scheduler.envLabel} />
              </span>
              <span className="text-xs text-muted-foreground">
                접속 {data.scheduler.connectionName} ·{' '}
                <span className="font-mono">{data.scheduler.schedName}</span>
              </span>
            </div>
            {result && resultCounts ? (
              <>
                <p className="tabular-nums">
                  {countText([
                    [resultCounts.changed, '실행'],
                    [resultCounts.unchanged, '변경 없음'],
                    [resultCounts.failure, '실패'],
                    [resultCounts.skipped, '건너뜀'],
                  ])}
                </p>
                <ul className="max-h-72 divide-y overflow-y-auto">
                  {failed.map((it) => (
                    <FailedRow key={batchKeyId(batchCommandKey(it.command))} item={it} />
                  ))}
                </ul>
              </>
            ) : counts ? (
              <>
                <p className="tabular-nums">
                  {countText([
                    [counts.run, '실행'],
                    [counts.noChange, '변경 없음'],
                    [counts.blocked, '실행 못 함'],
                  ])}
                </p>
                <ul className="max-h-72 divide-y overflow-y-auto">
                  {data.items.map((it) => (
                    <PreviewRow
                      key={batchKeyId(batchCommandKey(it.command))}
                      kind={kind}
                      item={it}
                    />
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  대상 DB 시각 {formatDateTime(data.dbNow)} 기준
                </p>
                {data.blocked ? (
                  <Alert variant="destructive">
                    <CircleAlertIcon aria-hidden />
                    <AlertTitle>실행할 수 없습니다</AlertTitle>
                    <AlertDescription>{data.blocked.message}</AlertDescription>
                  </Alert>
                ) : null}
                {action === 'resume' && hasMisfireWarning(data.items) ? (
                  <Alert>
                    <InfoIcon aria-hidden />
                    <AlertDescription>
                      실행 시각이 지난 트리거는 Quartz 노드가 misfire 정책에 따라 최대
                      1분(misfireThreshold) 안에 처리합니다.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {run.isError ? <FormAlert error={run.error} /> : null}

        <AlertDialogFooter>
          {result ? (
            <AlertDialogCancel>닫기</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel disabled={run.isPending}>취소</AlertDialogCancel>
              <AlertDialogAction
                disabled={!canRun}
                onClick={(e) => {
                  e.preventDefault();
                  if (data) run.mutate(data);
                }}
              >
                {run.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
                {batchConfirmLabel(action, counts?.run ?? 0)}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * 고른 줄이 있을 때 표 위에 나오는 일괄 제어 줄 (FR-CTL-10). 고른 수, 일시정지·재개, 선택 해제.
 * 항상 같은 높이를 차지해 넓은 화면에서는 나타나고 사라질 때 표가 밀리지 않는다(좁은 화면에서는 아래 줄로 내려간다).
 */
export function BatchBar({
  schedulerId,
  kind,
  selected,
  onClear,
  children,
}: {
  schedulerId: number;
  kind: BatchKind;
  selected: readonly BatchKey[];
  onClear: () => void;
  /** 고른 것이 없을 때 그 자리에 둘 내용(대상 DB 시각) */
  children?: ReactNode;
}) {
  const [dialog, setDialog] = useState<{
    seq: number;
    action: BatchAction;
    keys: BatchKey[];
    open: boolean;
  } | null>(null);
  const openDialog = (action: BatchAction) =>
    setDialog((prev) => ({ seq: (prev?.seq ?? 0) + 1, action, keys: [...selected], open: true }));
  const count = selected.length;
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
      {children}
      {count > 0 ? (
        <div
          role="toolbar"
          aria-label="고른 항목 일괄 제어"
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-sm font-medium tabular-nums" aria-live="polite">
            {count}개 선택됨
          </span>
          <Button variant="outline" size="sm" onClick={() => openDialog('pause')}>
            <PauseIcon data-icon="inline-start" aria-hidden />
            일시정지하기
          </Button>
          <Button variant="outline" size="sm" onClick={() => openDialog('resume')}>
            <PlayIcon data-icon="inline-start" aria-hidden />
            재개하기
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="선택 해제">
                <XIcon aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>선택 해제</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {dialog ? (
        <BatchDialog
          key={dialog.seq}
          schedulerId={schedulerId}
          kind={kind}
          action={dialog.action}
          keys={dialog.keys}
          open={dialog.open}
          onClose={() => setDialog((prev) => (prev ? { ...prev, open: false } : prev))}
          onDone={onClear}
        />
      ) : null}
    </div>
  );
}
