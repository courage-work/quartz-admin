'use client';

import {
  type AlertRuleDto,
  type AlertRuleInput,
  alertRuleInputSchema,
  type AlertRulesResponse,
  type AlertRuleType,
  type SchedulerDetailDto,
  SEVERITIES,
} from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, SearchXIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId } from 'react';
import {
  Controller,
  type FieldErrors,
  type Resolver,
  useFieldArray,
  useForm,
  type UseFormReturn,
  useWatch,
} from 'react-hook-form';
import { toast } from 'sonner';

import { FormActions } from '@/components/form/form-actions';
import { FormAlert } from '@/components/form/form-alert';
import { FormRow, FormRows } from '@/components/form/form-row';
import { TextField } from '@/components/form/text-field';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import { SEVERITY_META } from '@/components/status/tones';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ALERT_RULE_LABELS,
  ALERT_RULE_ORDER,
  alertRulesKey,
  defaultSeverity,
  describeCondition,
  isTriggerRule,
  type RuleFormValues,
  ruleFormPathOf,
  ruleFormValues,
  schedulerAlertsKey,
  toRuleRequest,
} from '@/lib/alerts';
import { api, isApiError } from '@/lib/api';
import { applyApiError } from '@/lib/form-errors';
import { parseId } from '@/lib/navigation';
import { usePageTitle } from '@/lib/page-title';
import { schedulerKey } from '@/lib/schedulers';

type Form = UseFormReturn<RuleFormValues>;

/** 서버와 같은 스키마로 검사한다. 오류 경로를 폼 입력 경로로 되돌린다 */
const ruleResolver: Resolver<RuleFormValues> = (values) => {
  const parsed = alertRuleInputSchema.safeParse(toRuleRequest(values));
  if (parsed.success) return { values, errors: {} };
  const errors: Record<string, unknown> = {};
  for (const issue of parsed.error.issues) {
    const path = ruleFormPathOf(issue.path);
    if (!path) continue;
    const err = { type: 'validate', message: issue.message };
    const [head, index, key] = path.split('.');
    if (head === 'triggers' && index !== undefined && key !== undefined) {
      const rows = (errors.triggers ??= []) as Record<string, unknown>[];
      const row = (rows[Number(index)] ??= {});
      row[key] ??= err;
    } else if (head === 'triggers') {
      errors.triggers ??= { root: err };
    } else {
      errors[path] ??= err;
    }
  }
  return { values: {}, errors: errors as FieldErrors<RuleFormValues> };
};

const SCOPE_OPTIONS = [
  { value: 'all', label: '전체 트리거' },
  { value: 'groups', label: '트리거 그룹' },
  { value: 'triggers', label: '특정 트리거' },
] as const;

function TypeField({ form, fixed }: { form: Form; fixed: AlertRuleType | null }) {
  const id = useId();
  if (fixed) {
    return (
      <FormRow label="규칙 종류">
        <p className="md:pt-2">{ALERT_RULE_LABELS[fixed]}</p>
      </FormRow>
    );
  }
  return (
    <Controller
      control={form.control}
      name="type"
      render={({ field }) => (
        <FormRow label="규칙 종류" htmlFor={id}>
          <Field>
            <Select
              value={field.value}
              onValueChange={(value) => {
                const type = value as AlertRuleType;
                // 심각도를 기본값 그대로 쓰고 있었다면 새 종류의 기본값으로 바꾼다
                if (form.getValues('severity') === defaultSeverity(field.value)) {
                  form.setValue('severity', defaultSeverity(type));
                }
                field.onChange(type);
              }}
            >
              <SelectTrigger id={id} className="w-full md:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ALERT_RULE_ORDER.map((t) => (
                    <SelectItem key={t} value={t}>
                      {ALERT_RULE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FormRow>
      )}
    />
  );
}

function ScopeFields({ form }: { form: Form }) {
  const labelId = useId();
  const groupsId = useId();
  const kind = useWatch({ control: form.control, name: 'scopeKind' });
  const triggers = useFieldArray({ control: form.control, name: 'triggers' });
  const groupsError = form.formState.errors.groups;
  const rowsError = form.formState.errors.triggers;
  return (
    <FormRows>
      <Controller
        control={form.control}
        name="scopeKind"
        render={({ field }) => (
          <FormRow label="대상" labelId={labelId}>
            <RadioGroup
              aria-labelledby={labelId}
              value={field.value}
              onValueChange={field.onChange}
              className="md:mt-2"
            >
              {SCOPE_OPTIONS.map((o) => (
                <Field key={o.value} orientation="horizontal">
                  <RadioGroupItem id={`${labelId}-${o.value}`} value={o.value} />
                  <FieldLabel htmlFor={`${labelId}-${o.value}`}>{o.label}</FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FormRow>
        )}
      />
      {kind === 'groups' ? (
        <FormRow label="그룹" htmlFor={groupsId} invalid={!!groupsError}>
          <Field data-invalid={groupsError ? true : undefined}>
            <Textarea
              id={groupsId}
              rows={4}
              mono
              className="md:max-w-xl"
              aria-invalid={groupsError ? true : undefined}
              {...form.register('groups')}
            />
            <FieldDescription>
              줄마다 그룹 이름 하나. 이름이 정확히 같은 그룹만 봅니다.
            </FieldDescription>
            <FieldError errors={[groupsError]} />
          </Field>
        </FormRow>
      ) : null}
      {kind === 'triggers' ? (
        <FormRow label="트리거" labelId={`${labelId}-triggers`} invalid={!!rowsError?.root}>
          <div className="flex flex-col gap-2 md:max-w-xl">
            {triggers.fields.map((row, i) => {
              const err = rowsError?.[i];
              return (
                <div key={row.id} className="flex items-start gap-2">
                  <Field data-invalid={err?.group ? true : undefined}>
                    <Input
                      mono
                      aria-label={`${i + 1}번째 트리거 그룹`}
                      placeholder="그룹"
                      aria-invalid={err?.group ? true : undefined}
                      {...form.register(`triggers.${i}.group`)}
                    />
                    <FieldError errors={[err?.group]} />
                  </Field>
                  <Field data-invalid={err?.name ? true : undefined}>
                    <Input
                      mono
                      aria-label={`${i + 1}번째 트리거 이름`}
                      placeholder="이름"
                      aria-invalid={err?.name ? true : undefined}
                      {...form.register(`triggers.${i}.name`)}
                    />
                    <FieldError errors={[err?.name]} />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${i + 1}번째 트리거 빼기`}
                    disabled={triggers.fields.length === 1}
                    onClick={() => triggers.remove(i)}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              );
            })}
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={() => triggers.append({ group: '', name: '' })}
              >
                <PlusIcon data-icon="inline-start" aria-hidden />
                트리거 추가
              </Button>
            </div>
            <FieldError errors={[rowsError?.root]} />
          </div>
        </FormRow>
      ) : null}
    </FormRows>
  );
}

function SeverityField({ form }: { form: Form }) {
  const id = useId();
  return (
    <Controller
      control={form.control}
      name="severity"
      render={({ field }) => (
        <FormRow label="심각도" htmlFor={id}>
          <Field>
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id={id} className="w-full md:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SEVERITY_META[s].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FormRow>
      )}
    />
  );
}

function EnabledField({ form }: { form: Form }) {
  const id = useId();
  return (
    <Controller
      control={form.control}
      name="enabled"
      render={({ field }) => (
        <FormRow label="사용" htmlFor={id}>
          <div className="md:pt-2">
            <Field orientation="horizontal">
              <Switch id={id} checked={field.value} onCheckedChange={field.onChange} />
              <FieldDescription>
                끄면 판정하지 않고, 열린 알림은 발송 없이 해소됩니다.
              </FieldDescription>
            </Field>
          </div>
        </FormRow>
      )}
    />
  );
}

const FIELDS = ['type', 'minutes', 'failures', 'groups', 'severity', 'renotify'] as const;

function RuleForm({
  scheduler,
  rule,
  back,
}: {
  scheduler: SchedulerDetailDto;
  rule: AlertRuleDto | undefined;
  back: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useForm<RuleFormValues>({
    mode: 'onSubmit',
    resolver: ruleResolver,
    defaultValues: ruleFormValues(rule),
  });
  const [type, minutesText, failuresText] = useWatch({
    control: form.control,
    name: ['type', 'minutes', 'failures'],
  });
  const minutes = Number(minutesText);
  const failures = Number(failuresText);
  // 입력 중인 값으로 조건을 다시 쓴다. 숫자가 아니면 기본값으로 쓴다
  const condition = describeCondition(
    {
      type,
      params: {
        ...(Number.isInteger(minutes) && minutes > 0 ? { minutes } : {}),
        ...(Number.isInteger(failures) && failures > 0 ? { failures } : {}),
      },
    },
    scheduler,
  );
  const save = useMutation({
    mutationFn: (body: AlertRuleInput) =>
      rule
        ? api<AlertRuleDto>(`/alert-rules/${rule.id}`, { method: 'PUT', body })
        : api<AlertRuleDto>(`/schedulers/${scheduler.id}/alert-rules`, { method: 'POST', body }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: alertRulesKey(scheduler.id) });
      void queryClient.invalidateQueries({ queryKey: schedulerAlertsKey(scheduler.id) });
      toast.success(
        `${ALERT_RULE_LABELS[saved.type]} 규칙을 ${rule ? '저장했습니다' : '추가했습니다'}`,
      );
      router.push(back);
    },
    onError: (err) => applyApiError(err, form.setError, {}, FIELDS),
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) =>
        void form.handleSubmit((v) =>
          // resolver가 통과시켰으므로 같은 스키마로 다시 바꾸면 성공한다
          save.mutate(alertRuleInputSchema.parse(toRuleRequest(v))),
        )(e)
      }
    >
      <FormAlert message={form.formState.errors.root?.message} />
      <Card>
        <CardHeader>
          <CardTitle>조건</CardTitle>
          <CardDescription>{condition}</CardDescription>
        </CardHeader>
        <CardContent>
          <FormRows>
            <TypeField form={form} fixed={rule?.type ?? null} />
            {type === 'BLOCKED_LONG' ? (
              <TextField
                form={form}
                name="minutes"
                label="BLOCKED 지속 시간(분)"
                autoComplete="off"
                description="이 시간보다 오래 BLOCKED이면 알립니다. 기본 30"
                layout="row"
                size="short"
              />
            ) : null}
            {type === 'MONITOR_UNREACHABLE' ? (
              <TextField
                form={form}
                name="failures"
                label="연속 실패 횟수"
                autoComplete="off"
                description={`감시 주기(${scheduler.pollIntervalSec}초)마다 한 번씩 셉니다. 기본 3`}
                layout="row"
                size="short"
              />
            ) : null}
          </FormRows>
        </CardContent>
      </Card>
      {isTriggerRule(type) ? (
        <Card>
          <CardHeader>
            <CardTitle>적용 범위</CardTitle>
          </CardHeader>
          <CardContent>
            <ScopeFields form={form} />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>알림</CardTitle>
          <CardDescription>규칙에 연결된 채널(지금은 인앱 알림)로 보냅니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <FormRows>
            <SeverityField form={form} />
            <TextField
              form={form}
              name="renotify"
              label="재알림 간격(분)"
              autoComplete="off"
              description="확인하지 않은 알림을 이 간격마다 다시 보냅니다. 비우면 다시 보내지 않습니다"
              layout="row"
              size="short"
            />
            <EnabledField form={form} />
          </FormRows>
        </CardContent>
      </Card>
      <FormActions>
        <Button asChild variant="outline">
          <Link href={back}>취소</Link>
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
          {rule ? '규칙 저장하기' : '규칙 추가하기'}
        </Button>
      </FormActions>
    </form>
  );
}

function NotFound({ what, back }: { what: string; back: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{what}을(를) 찾을 수 없습니다</EmptyTitle>
        <EmptyDescription>주소가 잘못됐거나 이미 삭제됐습니다.</EmptyDescription>
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
 * 알림 규칙 추가·수정 (`/scheduler/alert-rule?scheduler=N[&id=M]`, FR-ALT-06). 입력이 많아 대화상자 대신
 * 화면으로 둔다(DESIGN §8.1.3). 저장·취소 뒤 스케줄러의 알림 탭으로 돌아간다.
 */
export function AlertRuleView() {
  const params = useSearchParams();
  const schedulerId = parseId(params.get('scheduler'));
  const ruleId = parseId(params.get('id'));
  const detail = useQuery({
    queryKey: schedulerKey(schedulerId ?? 0),
    queryFn: ({ signal }) => api<SchedulerDetailDto>(`/schedulers/${schedulerId}`, { signal }),
    enabled: schedulerId !== null,
  });
  const rules = useQuery({
    queryKey: alertRulesKey(schedulerId ?? 0),
    queryFn: ({ signal }) =>
      api<AlertRulesResponse>(`/schedulers/${schedulerId}/alert-rules`, { signal }),
    enabled: schedulerId !== null && ruleId !== null,
  });
  const back = schedulerId === null ? '/' : `/scheduler?id=${schedulerId}&tab=alerts`;
  const title = ruleId === null ? '알림 규칙 추가' : '알림 규칙 수정';
  usePageTitle(detail.data ? `${detail.data.displayName} ${title}` : undefined);

  const trail = [
    { label: '대시보드', href: '/' },
    ...(detail.data ? [{ label: detail.data.displayName, href: back }] : []),
  ];
  const waitingRule = ruleId !== null && (rules.isPending || rules.isError);
  if (schedulerId === null || detail.isError || detail.isPending || waitingRule) {
    const error = detail.error ?? rules.error;
    return (
      <>
        <PageHeader trail={trail} title={title} />
        {schedulerId === null || isApiError(detail.error, 'NOT_FOUND') ? (
          <NotFound what="스케줄러" back="/" />
        ) : error ? (
          <FormAlert error={error} />
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </>
    );
  }
  const s = detail.data;
  const rule = ruleId === null ? undefined : rules.data?.rules.find((r) => r.id === ruleId);
  return (
    <>
      <ProdStripe environment={s.connection.envLabel} name={s.displayName} />
      <PageHeader
        trail={trail}
        title={title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <EnvBadge environment={s.connection.envLabel} />
            <span>{s.displayName}</span>
          </span>
        }
      />
      {ruleId !== null && !rule ? (
        <NotFound what="알림 규칙" back={back} />
      ) : (
        <RuleForm key={rule?.id ?? 'new'} scheduler={s} rule={rule} back={back} />
      )}
    </>
  );
}
