'use client';

import type {
  CronPreviewResponse,
  QuartzCommand,
  SchedulerDetailDto,
  TimeZonesResponse,
  TriggerDetailResponse,
  TriggerDto,
} from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleAlertIcon, SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { useCommandDialog } from '@/components/commands/use-command-dialog';
import { FormActions } from '@/components/form/form-actions';
import { FormAlert } from '@/components/form/form-alert';
import { FormRow, FormRows } from '@/components/form/form-row';
import { jobHref } from '@/components/schedulers/trigger-table';
import { TimeCell } from '@/components/schedulers/time-cell';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import { TriggerStateBadge } from '@/components/status/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, isApiError } from '@/lib/api';
import { controlBlockedReason, rescheduleBlockedReason } from '@/lib/commands';
import { formatDateTime } from '@/lib/format';
import { parseId } from '@/lib/navigation';
import { usePageTitle } from '@/lib/page-title';
import {
  INTERVAL_UNITS,
  parseSimpleSchedule,
  type SimpleScheduleErrors,
  type SimpleScheduleInput,
  splitInterval,
  toDatetimeLocal,
} from '@/lib/schedule-form';
import {
  browserTimeZone,
  formatInterval,
  isKnownTimeZone,
  schedulerKey,
  schedulerViewKey,
} from '@/lib/schedulers';

/** 입력을 멈춘 뒤 미리보기를 부르기까지 기다리는 시간 (TRD §7.6) */
const PREVIEW_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** 지금 스케줄 (상세 화면 정보 카드와 같은 배치) */
function CurrentSchedule({ trigger }: { trigger: TriggerDto }) {
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="md:col-span-3">{value}</dd>
    </>
  );
  const tz = trigger.cron?.timeZone;
  return (
    <Card>
      <CardHeader>
        <CardTitle>지금 스케줄</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-4">
          {row('상태', <TriggerStateBadge state={trigger.state} />)}
          {trigger.cron
            ? row(
                'cron 표현식',
                <span className="font-mono">
                  {trigger.cron.expression} · {tz ?? 'JVM 기본 타임존'}
                </span>,
              )
            : null}
          {trigger.simple
            ? row(
                '반복',
                `${formatInterval(trigger.simple.repeatIntervalMs)}마다 · ${
                  trigger.simple.repeatCount === -1
                    ? '무한 반복'
                    : `${trigger.simple.repeatCount}번 반복`
                } · 지금까지 ${trigger.simple.timesTriggered}번 실행`,
              )
            : null}
          {row('다음 실행', <TimeCell ms={trigger.nextFireTime} timeZone={tz} />)}
          {row(
            '시작 · 종료',
            `${formatDateTime(trigger.startTime)} · ${trigger.endTime ? formatDateTime(trigger.endTime) : '없음'}`,
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

/** CRON 스케줄 입력 (FR-CTL-06): 입력할 때마다 문법 오류와 다음 실행 5개를 보여 준다 */
function CronForm({
  trigger,
  back,
  onSubmit,
}: {
  trigger: TriggerDto;
  back: string;
  onSubmit: (command: QuartzCommand, returnTo: HTMLElement | null) => void;
}) {
  const exprId = useId();
  const tzId = useId();
  const listId = useId();
  const submitRef = useRef<HTMLButtonElement>(null);
  const [expression, setExpression] = useState(trigger.cron?.expression ?? '');
  const [timeZone, setTimeZone] = useState(trigger.cron?.timeZone ?? browserTimeZone());
  const [submitted, setSubmitted] = useState(false);
  const zones = useQuery({
    queryKey: ['cron-time-zones'],
    queryFn: ({ signal }) => api<TimeZonesResponse>('/cron/time-zones', { signal }),
    staleTime: Infinity,
  });
  const input = useDebounced(
    { expression: expression.trim(), timeZone: timeZone.trim() },
    PREVIEW_DEBOUNCE_MS,
  );
  const preview = useQuery({
    queryKey: ['cron-preview', input.expression, input.timeZone],
    queryFn: ({ signal }) =>
      api<CronPreviewResponse>('/cron/preview', {
        method: 'POST',
        body: { expression: input.expression, timeZone: input.timeZone },
        signal,
      }),
    enabled: input.expression.length > 0 && input.timeZone.length > 0,
    placeholderData: (prev) => prev,
    retry: false,
  });
  const result = preview.data;
  const empty = expression.trim().length === 0;
  const error =
    empty && submitted
      ? 'cron 표현식을 입력하세요'
      : result && !result.valid && result.error.code !== 'TIME_ZONE'
        ? result.error.message
        : undefined;
  const tzError =
    timeZone.trim().length === 0 && submitted
      ? '타임존을 고르세요'
      : result && !result.valid && result.error.code === 'TIME_ZONE'
        ? result.error.message
        : undefined;
  const ready =
    !empty &&
    !!result?.valid &&
    input.expression === expression.trim() &&
    input.timeZone === timeZone.trim();
  const tz = timeZone.trim();

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (!ready) return;
        onSubmit(
          {
            type: 'updateCronSchedule',
            trigger: { group: trigger.group, name: trigger.name },
            cronExpression: expression.trim(),
            timeZone: tz,
          },
          submitRef.current,
        );
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>새 스케줄</CardTitle>
          <CardDescription>
            시작 시각은 그대로 두고 다음 실행 시각만 새 식으로 다시 계산합니다. 일시정지된 트리거는
            수정 뒤에도 일시정지 상태입니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormRows>
            <FormRow label="cron 표현식" htmlFor={exprId} invalid={!!error}>
              <Field data-invalid={error ? true : undefined}>
                <Input
                  id={exprId}
                  mono
                  className="max-w-xl"
                  value={expression}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => setExpression(e.target.value)}
                />
                <FieldDescription>
                  초 분 시 일 월 요일 [연도]. 예: 매일 정오 <code>0 0 12 * * ?</code>, 평일 9시{' '}
                  <code>0 0 9 ? * MON-FRI</code>
                </FieldDescription>
                <FieldError>{error}</FieldError>
              </Field>
            </FormRow>
            <FormRow label="타임존" htmlFor={tzId} invalid={!!tzError}>
              <Field data-invalid={tzError ? true : undefined}>
                <Input
                  id={tzId}
                  className="max-w-xl"
                  list={listId}
                  value={timeZone}
                  autoComplete="off"
                  aria-invalid={tzError ? true : undefined}
                  onChange={(e) => setTimeZone(e.target.value)}
                />
                <datalist id={listId}>
                  {zones.data?.zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
                <FieldDescription>
                  Java 타임존 ID. 일·시를 이 타임존으로 해석합니다
                  {trigger.cron?.timeZone ? '' : '(지금은 노드 JVM 기본 타임존을 씁니다)'}
                </FieldDescription>
                <FieldError>{tzError}</FieldError>
              </Field>
            </FormRow>
            <FormRow label="다음 실행">
              {result?.valid ? (
                <ol className="flex flex-col gap-1 text-sm tabular-nums md:pt-2" aria-live="polite">
                  {result.nextFireTimes.map((t) => (
                    <li key={t}>
                      {formatDateTime(t)}
                      {tz && tz !== browserTimeZone() && isKnownTimeZone(tz) ? (
                        <span className="text-xs text-muted-foreground">
                          {' '}
                          · {formatDateTime(t, tz)} {tz}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {result.nextFireTimes.length === 0 ? (
                    <li className="text-muted-foreground">이 식으로는 실행 시각이 없습니다</li>
                  ) : null}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground md:pt-2">
                  {preview.isFetching
                    ? '계산하는 중입니다'
                    : '올바른 식을 입력하면 다음 실행 5개를 보여 줍니다'}
                </p>
              )}
            </FormRow>
          </FormRows>
        </CardContent>
      </Card>
      {preview.isError ? <FormAlert error={preview.error} /> : null}
      <FormActions>
        <Button asChild variant="outline">
          <Link href={back}>취소</Link>
        </Button>
        <Button ref={submitRef} type="submit" disabled={submitted && !ready && !empty}>
          스케줄 수정하기
        </Button>
      </FormActions>
    </form>
  );
}

/** SIMPLE 스케줄 입력 (FR-CTL-07): 간격·반복 횟수·시작 시각. 지금부터(또는 지정한 시각부터) 다시 시작한다 */
function SimpleForm({
  trigger,
  back,
  onSubmit,
}: {
  trigger: TriggerDto;
  back: string;
  onSubmit: (command: QuartzCommand, returnTo: HTMLElement | null) => void;
}) {
  const intervalId = useId();
  const unitId = useId();
  const countId = useId();
  const infiniteId = useId();
  const startLabelId = useId();
  const startAtId = useId();
  const submitRef = useRef<HTMLButtonElement>(null);
  const initial = splitInterval(trigger.simple?.repeatIntervalMs ?? 60_000);
  const [input, setInput] = useState<SimpleScheduleInput>(() => ({
    interval: String(initial.value),
    unitMs: initial.unitMs,
    repeatCount:
      trigger.simple && trigger.simple.repeatCount >= 0 ? String(trigger.simple.repeatCount) : '',
    infinite: trigger.simple?.repeatCount === -1,
    startMode: 'now',
    startAt: toDatetimeLocal(Date.now() + 3_600_000),
  }));
  /** 오류는 저장할 때, 그 뒤로는 고칠 때마다 다시 검사한다(DESIGN §8.1.3) */
  const [errors, setErrors] = useState<SimpleScheduleErrors | null>(null);
  const update = (patch: Partial<SimpleScheduleInput>) => {
    const next = { ...input, ...patch };
    setInput(next);
    if (errors) setErrors(parseSimpleSchedule(next, Date.now()).errors ?? {});
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseSimpleSchedule(input, Date.now());
        setErrors(parsed.errors ?? {});
        if (!parsed.values) return;
        onSubmit(
          {
            type: 'updateSimpleSchedule',
            trigger: { group: trigger.group, name: trigger.name },
            ...parsed.values,
          },
          submitRef.current,
        );
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>새 스케줄</CardTitle>
          <CardDescription>
            실행 횟수를 0으로 되돌리고 시작 시각부터 새 간격으로 다시 시작합니다. 일시정지된
            트리거는 수정 뒤에도 일시정지 상태입니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormRows>
            <FormRow label="간격" htmlFor={intervalId} invalid={!!errors?.interval}>
              <Field data-invalid={errors?.interval ? true : undefined}>
                <div className="flex max-w-xs gap-2">
                  <Input
                    id={intervalId}
                    inputMode="numeric"
                    autoComplete="off"
                    value={input.interval}
                    aria-invalid={errors?.interval ? true : undefined}
                    onChange={(e) => update({ interval: e.target.value })}
                  />
                  <Select
                    value={String(input.unitMs)}
                    onValueChange={(v) => update({ unitMs: Number(v) })}
                  >
                    <SelectTrigger id={unitId} aria-label="간격 단위" className="w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {INTERVAL_UNITS.map((u) => (
                          <SelectItem key={u.ms} value={String(u.ms)}>
                            {u.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <FieldError>{errors?.interval}</FieldError>
              </Field>
            </FormRow>
            <FormRow label="반복 횟수" htmlFor={countId} invalid={!!errors?.repeatCount}>
              <Field data-invalid={errors?.repeatCount ? true : undefined}>
                <Input
                  id={countId}
                  className="max-w-40"
                  inputMode="numeric"
                  autoComplete="off"
                  value={input.infinite ? '' : input.repeatCount}
                  disabled={input.infinite}
                  aria-invalid={errors?.repeatCount ? true : undefined}
                  onChange={(e) => update({ repeatCount: e.target.value })}
                />
                <Field orientation="horizontal">
                  <Checkbox
                    id={infiniteId}
                    checked={input.infinite}
                    onCheckedChange={(v) => update({ infinite: v === true })}
                  />
                  <FieldLabel htmlFor={infiniteId}>무한 반복</FieldLabel>
                </Field>
                <FieldDescription>
                  첫 실행 뒤 더 실행할 횟수입니다. 0이면 한 번만 실행합니다
                </FieldDescription>
                <FieldError>{errors?.repeatCount}</FieldError>
              </Field>
            </FormRow>
            <FormRow label="시작" labelId={startLabelId} invalid={!!errors?.startAt}>
              <Field data-invalid={errors?.startAt ? true : undefined}>
                <RadioGroup
                  aria-labelledby={startLabelId}
                  value={input.startMode}
                  onValueChange={(v) => update({ startMode: v === 'at' ? 'at' : 'now' })}
                  className="md:mt-2"
                >
                  <Field orientation="horizontal">
                    <RadioGroupItem id={`${startAtId}-now`} value="now" />
                    <FieldLabel htmlFor={`${startAtId}-now`}>지금부터</FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem id={`${startAtId}-at`} value="at" />
                    <FieldLabel htmlFor={`${startAtId}-at`}>시각 지정</FieldLabel>
                  </Field>
                </RadioGroup>
                {input.startMode === 'at' ? (
                  <Input
                    id={startAtId}
                    type="datetime-local"
                    aria-label="시작 시각"
                    className="max-w-60"
                    value={input.startAt}
                    aria-invalid={errors?.startAt ? true : undefined}
                    onChange={(e) => update({ startAt: e.target.value })}
                  />
                ) : null}
                <FieldDescription>
                  시각은 브라우저 타임존({browserTimeZone()})입니다
                </FieldDescription>
                <FieldError>{errors?.startAt}</FieldError>
              </Field>
            </FormRow>
          </FormRows>
        </CardContent>
      </Card>
      <FormActions>
        <Button asChild variant="outline">
          <Link href={back}>취소</Link>
        </Button>
        <Button ref={submitRef} type="submit">
          스케줄 수정하기
        </Button>
      </FormActions>
    </form>
  );
}

function NotFound({ back }: { back: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>트리거를 찾을 수 없습니다</EmptyTitle>
        <EmptyDescription>주소가 잘못됐거나 이미 삭제된 트리거입니다.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href={back}>돌아가기</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/**
 * 트리거 스케줄 수정 (`/trigger/schedule?scheduler=N&group=&name=`, FR-CTL-06, 07, TRD §7.6).
 * 입력이 길어 대화상자 대신 화면으로 두고(DESIGN §8 오버레이 선택), 저장하면 공통 확인 대화상자가 바뀌기 전·후
 * 스케줄과 다음 실행 시각을 보여 준 뒤 실행한다. 성공하면 들어온 화면으로 돌아간다.
 */
export function TriggerScheduleView() {
  const params = useSearchParams();
  const router = useRouter();
  const schedulerId = parseId(params.get('scheduler'));
  const group = params.get('group');
  const name = params.get('name');
  const jobGroup = params.get('jobGroup');
  const jobName = params.get('jobName');
  const fromJob = params.get('from') === 'job' && !!jobGroup && !!jobName;
  const valid = schedulerId !== null && !!group && !!name;
  const back =
    schedulerId === null
      ? '/'
      : fromJob
        ? jobHref(schedulerId, jobGroup, jobName)
        : `/scheduler?id=${schedulerId}&tab=triggers`;

  const scheduler = useQuery({
    queryKey: schedulerKey(schedulerId ?? 0),
    queryFn: ({ signal }) => api<SchedulerDetailDto>(`/schedulers/${schedulerId}`, { signal }),
    enabled: schedulerId !== null,
  });
  const detail = useQuery({
    queryKey: schedulerViewKey(schedulerId ?? 0, 'trigger', { group, name }),
    queryFn: ({ signal }) =>
      api<TriggerDetailResponse>(`/schedulers/${schedulerId}/triggers/detail`, {
        query: { group, name },
        signal,
      }),
    enabled: valid,
  });
  const { openCommand, dialog } = useCommandDialog(schedulerId ?? 0, () => router.push(back));
  usePageTitle(name ? `${name} 스케줄 수정` : undefined);

  const s = scheduler.data;
  const trigger = detail.data?.trigger;
  const blocked = s ? controlBlockedReason(s.connection) : null;
  const notEditable = trigger ? rescheduleBlockedReason(trigger) : null;

  let body: ReactNode;
  if (!valid || isApiError(detail.error, 'NOT_FOUND')) body = <NotFound back={back} />;
  else if (detail.isError) body = <FormAlert error={detail.error} />;
  else if (!trigger || !s) body = <Skeleton className="h-64 w-full" />;
  else {
    const reason = blocked ?? notEditable;
    body = (
      <div className="flex flex-col gap-6">
        <CurrentSchedule trigger={trigger} />
        {reason ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden />
            <AlertTitle>스케줄을 수정할 수 없습니다</AlertTitle>
            <AlertDescription>{reason}</AlertDescription>
          </Alert>
        ) : trigger.type === 'CRON' ? (
          <CronForm trigger={trigger} back={back} onSubmit={openCommand} />
        ) : (
          <SimpleForm trigger={trigger} back={back} onSubmit={openCommand} />
        )}
      </div>
    );
  }

  return (
    <>
      {s ? <ProdStripe environment={s.connection.envLabel} name={s.displayName} /> : null}
      <PageHeader
        trail={[
          { label: '대시보드', href: '/' },
          ...(schedulerId !== null
            ? [
                {
                  label: s?.displayName ?? '스케줄러',
                  href: `/scheduler?id=${schedulerId}&tab=triggers`,
                },
              ]
            : []),
          ...(fromJob && schedulerId !== null ? [{ label: jobName, href: back }] : []),
        ]}
        title={name ? `${name} 스케줄 수정` : '스케줄 수정'}
        description={
          s ? (
            <span className="flex flex-wrap items-center gap-2">
              <EnvBadge environment={s.connection.envLabel} />
              {group ? <span className="font-mono text-xs">{group}</span> : null}
            </span>
          ) : undefined
        }
      />
      {body}
      {dialog}
    </>
  );
}
