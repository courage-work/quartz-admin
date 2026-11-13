'use client';

import type {
  AlertDto,
  AlertRuleDto,
  AlertRulesResponse,
  SchedulerAlertsResponse,
} from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellOffIcon,
  CircleCheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { FormAlert } from '@/components/form/form-alert';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useMountTime } from '@/components/schedulers/mute-control';
import { formatMuteUntil } from '@/lib/mute';
import { TimeCell } from '@/components/schedulers/time-cell';
import { SeverityBadge } from '@/components/status/status-badge';
import { TableEmpty } from '@/components/table-empty';
import { TableFrame } from '@/components/table-frame';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ALERT_RULE_LABELS,
  alertRulesKey,
  describeAffected,
  describeAlertStatus,
  describeCondition,
  describeRenotify,
  describeScope,
  ruleInputOf,
  schedulerAlertsKey,
  type SchedulerThresholds,
} from '@/lib/alerts';
import { api } from '@/lib/api';
import { schedulerKey } from '@/lib/schedulers';

function LoadingRows({ columns }: { columns: number }) {
  return Array.from({ length: 2 }, (_, i) => (
    <TableRow key={i}>
      <TableCell colSpan={columns}>
        <Skeleton className="h-5 w-full" />
      </TableCell>
    </TableRow>
  ));
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function AlertRows({ alerts, resolved }: { alerts: AlertDto[]; resolved: boolean }) {
  return alerts.map((a) => (
    <TableRow key={a.id}>
      <TableCell>
        <SeverityBadge severity={a.severity} />
      </TableCell>
      <TableCell>{ALERT_RULE_LABELS[a.type]}</TableCell>
      <TableCell className="max-w-80">
        {/* 트리거 키만 고정폭이다. 노드 수·감시 실패는 문장이다 */}
        {a.affected?.kind === 'triggers' ? (
          <span className="block truncate font-mono" title={describeAffected(a.affected)}>
            {describeAffected(a.affected)}
          </span>
        ) : (
          <span className="block truncate" title={describeAffected(a.affected)}>
            {describeAffected(a.affected)}
          </span>
        )}
      </TableCell>
      <TableCell>
        <TimeCell ms={a.firstSeenAt} />
      </TableCell>
      <TableCell>
        {resolved ? <TimeCell ms={a.resolvedAt} /> : <span>{describeAlertStatus(a)}</span>}
      </TableCell>
    </TableRow>
  ));
}

function AlertTable({ alerts, resolved }: { alerts: AlertDto[] | undefined; resolved: boolean }) {
  return (
    <TableFrame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">심각도</TableHead>
            <TableHead>규칙</TableHead>
            <TableHead>대상</TableHead>
            <TableHead>발생</TableHead>
            <TableHead>{resolved ? '해소' : '상태'}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!alerts ? (
            <LoadingRows columns={5} />
          ) : alerts.length === 0 ? (
            <TableEmpty
              colSpan={5}
              icon={resolved ? BellOffIcon : CircleCheckIcon}
              title={resolved ? '해소된 알림이 없습니다' : '열린 알림이 없습니다'}
              description={
                resolved ? undefined : '규칙의 조건이 성립하면 다음 감시 회차에 여기에 나타납니다.'
              }
            />
          ) : (
            <AlertRows alerts={alerts} resolved={resolved} />
          )}
        </TableBody>
      </Table>
    </TableFrame>
  );
}

function RuleMenu({
  rule,
  schedulerId,
  onDelete,
}: {
  rule: AlertRuleDto;
  schedulerId: number;
  onDelete: (rule: AlertRuleDto) => void;
}) {
  const label = `${ALERT_RULE_LABELS[rule.type]} 규칙 메뉴`;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={label}>
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/scheduler/alert-rule?scheduler=${schedulerId}&id=${rule.id}`}>
            <PencilIcon aria-hidden />
            수정
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(rule)}>
          <Trash2Icon aria-hidden />
          삭제
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RulesTable({
  schedulerId,
  thresholds,
}: {
  schedulerId: number;
  thresholds: SchedulerThresholds;
}) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<AlertRuleDto | null>(null);
  const rules = useQuery({
    queryKey: alertRulesKey(schedulerId),
    queryFn: ({ signal }) =>
      api<AlertRulesResponse>(`/schedulers/${schedulerId}/alert-rules`, { signal }),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: alertRulesKey(schedulerId) });
    void queryClient.invalidateQueries({ queryKey: schedulerAlertsKey(schedulerId) });
    void queryClient.invalidateQueries({ queryKey: schedulerKey(schedulerId), exact: true });
  };
  const toggle = useMutation({
    mutationFn: ({ rule, enabled }: { rule: AlertRuleDto; enabled: boolean }) =>
      api<AlertRuleDto>(`/alert-rules/${rule.id}`, {
        method: 'PUT',
        body: ruleInputOf(rule, { enabled }),
      }),
    onSuccess: (saved) => {
      toast.success(
        `${ALERT_RULE_LABELS[saved.type]} 규칙을 ${saved.enabled ? '켰습니다' : '껐습니다'}`,
      );
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const remove = useMutation({
    mutationFn: (rule: AlertRuleDto) => api<void>(`/alert-rules/${rule.id}`, { method: 'DELETE' }),
    onSuccess: (_, rule) => {
      toast.success(`${ALERT_RULE_LABELS[rule.type]} 규칙을 삭제했습니다`);
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  return (
    <Section
      title="알림 규칙"
      description="바꾼 규칙은 다음 감시 회차부터 반영됩니다. 끄거나 지운 규칙의 열린 알림은 발송 없이 해소됩니다."
      action={
        <Button asChild variant="outline">
          <Link href={`/scheduler/alert-rule?scheduler=${schedulerId}`}>
            <PlusIcon data-icon="inline-start" aria-hidden />
            규칙 추가
          </Link>
        </Button>
      }
    >
      {rules.isError ? <FormAlert error={rules.error} /> : null}
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>규칙 / 조건</TableHead>
              <TableHead>범위</TableHead>
              <TableHead className="w-24">심각도</TableHead>
              <TableHead>재알림</TableHead>
              <TableHead className="w-16">사용</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">메뉴</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!rules.data ? (
              <LoadingRows columns={6} />
            ) : rules.data.rules.length === 0 ? (
              <TableEmpty
                colSpan={6}
                icon={BellOffIcon}
                title="알림 규칙이 없습니다"
                description="규칙을 추가해야 이 스케줄러의 문제를 알릴 수 있습니다."
              />
            ) : (
              rules.data.rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <span className="flex flex-col">
                      <span>{ALERT_RULE_LABELS[rule.type]}</span>
                      <span className="text-xs text-muted-foreground">
                        {describeCondition(rule, thresholds)}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-56">
                    <span className="block truncate" title={describeScope(rule.scope)}>
                      {describeScope(rule.scope)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={rule.severity} />
                  </TableCell>
                  <TableCell>{describeRenotify(rule.renotifyMinutes)}</TableCell>
                  <TableCell>
                    <Switch
                      checked={rule.enabled}
                      disabled={toggle.isPending}
                      aria-label={`${ALERT_RULE_LABELS[rule.type]} 규칙 사용`}
                      onCheckedChange={(enabled) => toggle.mutate({ rule, enabled })}
                    />
                  </TableCell>
                  <TableCell>
                    <RuleMenu rule={rule} schedulerId={schedulerId} onDelete={setDeleting} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableFrame>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting ? `${ALERT_RULE_LABELS[deleting.type]} 규칙을 삭제할까요?` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              이 규칙의 열린 알림은 발송 없이 해소되고, 지난 알림 기록은 남습니다. 잠시 멈추려면
              삭제 대신 사용을 끄세요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) remove.mutate(deleting);
              }}
            >
              규칙 삭제하기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

/**
 * 스케줄러의 알림 탭 (FR-ALT-06, 08, 09). 열린 알림, 알림 규칙, 최근 해소된 알림.
 * 알림 확인(ack)과 알림 센터는 B-25에서 붙인다. 목록은 메타 저장소에서 읽는다(대상 DB를 조회하지 않음).
 */
export function AlertsTab({
  schedulerId,
  refreshMs,
  thresholds,
  mutedUntil,
}: {
  schedulerId: number;
  refreshMs: number;
  thresholds: SchedulerThresholds;
  /** 알림 음소거가 끝나는 시각. 음소거 중이 아니면 null (FR-ALT-10) */
  mutedUntil: number | null;
}) {
  const alerts = useQuery({
    queryKey: schedulerAlertsKey(schedulerId),
    queryFn: ({ signal }) =>
      api<SchedulerAlertsResponse>(`/schedulers/${schedulerId}/alerts`, { signal }),
    refetchInterval: refreshMs || false,
  });
  const now = useMountTime();
  return (
    <div className="flex flex-col gap-8">
      {mutedUntil !== null ? (
        <Alert>
          <BellOffIcon aria-hidden />
          <AlertTitle>{formatMuteUntil(mutedUntil, now)}까지 알림 음소거 중입니다</AlertTitle>
          <AlertDescription>
            알림 상태는 계속 기록하고 보내지 않습니다. 음소거가 끝난 뒤 열려 있는 알림을 보내고,
            음소거 전에 보낸 알림이 그사이 해소되면 해소 알림을 보냅니다.
          </AlertDescription>
        </Alert>
      ) : null}
      <Section
        title="열린 알림"
        description="클러스터 다운이나 감시 불가가 열려 있으면 실행 지연·BLOCKED·노드 이탈 알림은 기록만 하고 보내지 않습니다."
      >
        {alerts.isError ? <FormAlert error={alerts.error} /> : null}
        <AlertTable alerts={alerts.data?.open} resolved={false} />
      </Section>
      <RulesTable schedulerId={schedulerId} thresholds={thresholds} />
      <Section title="최근 해소된 알림">
        <AlertTable alerts={alerts.data?.resolved} resolved />
      </Section>
    </div>
  );
}
