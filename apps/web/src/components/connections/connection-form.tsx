'use client';

import {
  type ConnectionDto,
  type ConnectionTestResult,
  createConnectionRequestSchema,
  DB_KINDS,
  SUPPORTED_DB_KINDS,
  testConnectionRequestSchema,
  updateConnectionRequestSchema,
} from '@qa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheckIcon,
  CircleXIcon,
  HistoryIcon,
  PlugZapIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Controller, type Resolver, useForm, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { FormActions } from '@/components/form/form-actions';
import { FormAlert } from '@/components/form/form-alert';
import { FormRow, FormRows } from '@/components/form/form-row';
import { TextField } from '@/components/form/text-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import {
  CONNECTIONS_KEY,
  type ConnectionFormValues,
  connectionFormValues,
  DB_KIND_LABELS,
  DEFAULT_PORTS,
  EMPTY_CONNECTION_FORM,
  formFieldOf,
  TEST_FAILURE_HINTS,
  toConnectionRequest,
} from '@/lib/connections';
import {
  clearConnectionDraft,
  connectionDraftSavedAt,
  type DraftScope,
  isBlankDraft,
  loadConnectionDraft,
  NEW_DRAFT,
  saveConnectionDraft,
} from '@/lib/connection-draft';
import { applyApiError } from '@/lib/form-errors';
import { formatDateTime } from '@/lib/format';

const FORM_FIELDS: (keyof ConnectionFormValues)[] = [
  'name',
  'dbType',
  'host',
  'port',
  'oracleName',
  'database',
  'schemaName',
  'username',
  'password',
  'envLabel',
  'tags',
  'readOnly',
];

/**
 * 서버와 같은 zod 스키마로 검사하는 resolver. 폼 값을 요청 형태로 바꾼 뒤 검사하고,
 * 오류 경로(`oracleServiceName` 등)를 폼 입력 이름으로 되돌린다.
 */
function schemaResolver(schema: z.ZodType): Resolver<ConnectionFormValues> {
  return (values) => {
    const parsed = schema.safeParse(toConnectionRequest(values));
    if (parsed.success) return { values, errors: {} };
    const errors: Partial<Record<keyof ConnectionFormValues, { type: string; message: string }>> =
      {};
    for (const issue of parsed.error.issues) {
      const field = formFieldOf(issue.path.join('.'));
      if (field && !errors[field]) errors[field] = { type: 'validate', message: issue.message };
    }
    return { values: {}, errors };
  };
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <CircleXIcon aria-hidden />
        <AlertTitle>{result.message}</AlertTitle>
        <AlertDescription>{TEST_FAILURE_HINTS[result.code] ?? ''}</AlertDescription>
      </Alert>
    );
  }
  const noQuartz = result.tableSetCount === 0;
  return (
    <Alert variant={noQuartz || result.writeCapable === false ? 'warning' : 'success'}>
      {noQuartz ? <TriangleAlertIcon aria-hidden /> : <CircleCheckIcon aria-hidden />}
      <AlertTitle>
        연결했습니다({result.durationMs}ms). 스키마 {result.schema}
      </AlertTitle>
      <AlertDescription>
        {noQuartz
          ? '이 스키마에서 Quartz 테이블을 찾지 못했습니다. 스키마 이름과 조회 권한을 확인하세요.'
          : `Quartz 테이블 세트 ${result.tableSetCount}개, 스케줄러 후보 ${result.schedulerCount}개를 찾았습니다.` +
            (result.writeCapable === false
              ? ' 쓰기 권한이 없어 읽기 전용으로 등록됩니다.'
              : ' 쓰기 권한도 확인했습니다.')}
      </AlertDescription>
    </Alert>
  );
}

function TargetFields({
  form,
  editing,
}: {
  form: UseFormReturn<ConnectionFormValues>;
  editing: boolean;
}) {
  const dbTypeId = useId();
  const oracleModeId = useId();
  const dbType = form.watch('dbType');
  const oracleMode = form.watch('oracleMode');
  const dbTypeError = form.getFieldState('dbType', form.formState).error;

  return (
    <FormRows>
      <Controller
        control={form.control}
        name="dbType"
        render={({ field }) => (
          <FormRow label="DB 종류" htmlFor={dbTypeId} invalid={!!dbTypeError}>
            <Field data-invalid={dbTypeError ? true : undefined}>
              <Select
                value={field.value}
                onValueChange={(value) => {
                  const kind = value as ConnectionFormValues['dbType'];
                  // 기본 포트를 그대로 쓰고 있었다면 새 종류의 기본 포트로 바꾼다
                  if (form.getValues('port') === String(DEFAULT_PORTS[field.value])) {
                    form.setValue('port', String(DEFAULT_PORTS[kind]));
                  }
                  field.onChange(kind);
                }}
              >
                <SelectTrigger
                  id={dbTypeId}
                  aria-invalid={dbTypeError ? true : undefined}
                  className="w-full md:w-64"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {DB_KINDS.map((kind) => (
                      <SelectItem
                        key={kind}
                        value={kind}
                        disabled={!SUPPORTED_DB_KINDS.includes(kind)}
                      >
                        {DB_KIND_LABELS[kind]}
                        {SUPPORTED_DB_KINDS.includes(kind) ? '' : ' (지원 예정)'}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldError errors={[dbTypeError]} />
            </Field>
          </FormRow>
        )}
      />
      <TextField form={form} name="host" label="호스트" autoComplete="off" layout="row" />
      <TextField
        form={form}
        name="port"
        label="포트"
        autoComplete="off"
        layout="row"
        size="short"
      />
      {dbType === 'oracle' ? (
        <>
          <FormRow label="접속 방식" labelId={oracleModeId}>
            <Controller
              control={form.control}
              name="oracleMode"
              render={({ field }) => (
                <RadioGroup
                  aria-labelledby={oracleModeId}
                  value={field.value}
                  onValueChange={field.onChange}
                  className="md:mt-2"
                >
                  <Field orientation="horizontal">
                    <RadioGroupItem id={`${oracleModeId}-service`} value="service" />
                    <FieldLabel htmlFor={`${oracleModeId}-service`}>서비스 이름</FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem id={`${oracleModeId}-sid`} value="sid" />
                    <FieldLabel htmlFor={`${oracleModeId}-sid`}>SID</FieldLabel>
                  </Field>
                </RadioGroup>
              )}
            />
          </FormRow>
          <TextField
            form={form}
            name="oracleName"
            label={oracleMode === 'sid' ? 'SID' : '서비스 이름'}
            autoComplete="off"
            description={oracleMode === 'sid' ? '예: ORCL' : '예: ORCLPDB1'}
            layout="row"
          />
        </>
      ) : (
        <TextField form={form} name="database" label="DB 이름" autoComplete="off" layout="row" />
      )}
      <TextField
        form={form}
        name="schemaName"
        label="스키마(선택)"
        autoComplete="off"
        description="Quartz 테이블이 있는 스키마입니다. 비워 두면 접속 계정의 기본 스키마를 봅니다."
        layout="row"
      />
      <TextField form={form} name="username" label="계정" autoComplete="off" layout="row" />
      <TextField
        form={form}
        name="password"
        label="비밀번호"
        type="password"
        autoComplete="new-password"
        description={editing ? '비워 두면 저장된 비밀번호를 그대로 씁니다.' : undefined}
        layout="row"
      />
    </FormRows>
  );
}

/** 접속 추가·수정 화면의 폼 (FR-CON-01, 02, 05) */
export function ConnectionForm({ connection }: { connection?: ConnectionDto }) {
  const editing = connection !== undefined;
  const router = useRouter();
  const queryClient = useQueryClient();
  const readOnlyId = useId();
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  const form = useForm<ConnectionFormValues>({
    // 저장할 때 검사한다. 값을 바꾼 칸은 벗어날 때, 오류가 뜬 칸은 고칠 때 검사한다(TextField)
    mode: 'onSubmit',
    resolver: schemaResolver(
      editing ? updateConnectionRequestSchema : createConnectionRequestSchema,
    ),
    defaultValues: connection ? connectionFormValues(connection) : EMPTY_CONNECTION_FORM,
  });

  // 입력을 1초 뒤에 임시 저장하고(비밀번호 제외), 다시 열면 불러온다. 수정 폼은 접속마다 따로 둔다
  const baseValues = useMemo(
    () => (connection ? connectionFormValues(connection) : EMPTY_CONNECTION_FORM),
    [connection],
  );
  const scope = useMemo<DraftScope>(
    () =>
      connection
        ? { kind: 'edit', id: connection.id, baseUpdatedAt: connection.updatedAt }
        : NEW_DRAFT,
    [connection],
  );
  const draftSavedAt = useSyncExternalStore(
    () => () => undefined,
    () => connectionDraftSavedAt(scope),
    () => null,
  );
  const [draftDismissed, setDraftDismissed] = useState(false);
  useEffect(() => {
    const draft = loadConnectionDraft(scope);
    if (draft)
      form.reset({ ...baseValues, ...draft.values, password: '' }, { keepDefaultValues: true });
  }, [scope, baseValues, form]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = form.subscribe({
      formState: { values: true },
      callback: ({ values }) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const v = { ...baseValues, ...values };
          if (isBlankDraft(v, baseValues)) clearConnectionDraft(scope);
          else saveConnectionDraft(v, scope);
        }, 1_000);
      },
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [scope, baseValues, form]);

  // 저장하지 않은 변경이 있으면 새로고침·탭 닫기 전에 브라우저가 묻는다
  const { isDirty } = form.formState;
  const savedRef = useRef(false);
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (savedRef.current) return;
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const save = useMutation({
    mutationFn: (values: ConnectionFormValues) =>
      editing
        ? api<ConnectionDto>(`/connections/${connection.id}`, {
            method: 'PUT',
            body: toConnectionRequest(values),
          })
        : api<ConnectionDto>('/connections', { method: 'POST', body: toConnectionRequest(values) }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success(
        editing ? `${saved.name} 접속을 저장했습니다` : `${saved.name} 접속을 추가했습니다`,
      );
      savedRef.current = true;
      clearConnectionDraft(scope);
      // 새 접속은 바로 스케줄러를 감지한다
      router.push(`/connection?id=${saved.id}${editing ? '' : '&detect=1'}`);
    },
    onError: (err) =>
      applyApiError(err, form.setError, { CONNECTION_NAME_TAKEN: 'name' }, FORM_FIELDS),
  });

  const test = useMutation({
    mutationFn: (values: ConnectionFormValues) =>
      api<ConnectionTestResult>('/connections/test', {
        method: 'POST',
        body: {
          ...toConnectionRequest(values),
          ...(editing ? { connectionId: connection.id } : {}),
        },
      }),
    onMutate: () => setTestResult(null),
    onSuccess: setTestResult,
    onError: (err) => applyApiError(err, form.setError, {}, FORM_FIELDS),
  });

  /** 연결 테스트는 이름·환경 같은 저장용 값 없이도 돌릴 수 있게 연결 값만 검사한다 */
  const runTest = async () => {
    const values = form.getValues();
    const parsed = testConnectionRequestSchema.safeParse({
      ...toConnectionRequest(values),
      ...(editing ? { connectionId: connection.id } : {}),
    });
    form.clearErrors();
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = formFieldOf(issue.path.join('.'));
        if (field) form.setError(field, { message: issue.message });
      }
      return;
    }
    await test.mutateAsync(values).catch(() => undefined);
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => void form.handleSubmit((values) => save.mutate(values))(e)}
    >
      <FormAlert message={form.formState.errors.root?.message} />
      {draftSavedAt !== null && !draftDismissed ? (
        <Alert>
          <HistoryIcon aria-hidden />
          <AlertTitle>
            임시 저장한 입력을 불러왔습니다({formatDateTime(draftSavedAt)} 저장)
          </AlertTitle>
          <AlertDescription>
            <span className="flex flex-wrap items-center gap-2">
              비밀번호는 저장하지 않으니 다시 입력하세요.
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  clearConnectionDraft(scope);
                  // 수정 폼은 저장된 접속 값으로, 새 폼은 빈 값으로 되돌린다
                  form.reset(baseValues);
                  setDraftDismissed(true);
                }}
              >
                임시 저장 버리기
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {/* 상세 화면과 같은 카드 나눔·순서·라벨 칸(1/4)이라 상세 ↔ 수정을 오가도 자리가 같다 (B-40) */}
      <Card>
        <CardHeader>
          <CardTitle>접속 정보</CardTitle>
          <CardDescription>
            Quartz 테이블이 있는 DB에 붙을 정보입니다. 비밀번호는 암호화해 저장하고 화면에 다시 보여
            주지 않습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormRows>
            <TargetFields form={form} editing={editing} />
            <FormRow>
              <div className="flex flex-col items-start gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={test.isPending}
                  onClick={() => void runTest()}
                >
                  {test.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <PlugZapIcon data-icon="inline-start" aria-hidden />
                  )}
                  연결 테스트하기
                </Button>
                {testResult ? <TestResult result={testResult} /> : null}
              </div>
            </FormRow>
          </FormRows>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>표시와 권한</CardTitle>
        </CardHeader>
        <CardContent>
          <FormRows>
            <TextField
              form={form}
              name="name"
              label="접속 이름"
              autoComplete="off"
              description="목록과 감사 로그에 보이는 이름입니다."
              layout="row"
            />
            <TextField
              form={form}
              name="envLabel"
              label="환경 라벨"
              autoComplete="off"
              description="prod, stage, dev처럼 씁니다. prod는 화면에 빨갛게 표시됩니다."
              layout="row"
              size="short"
            />
            <TextField
              form={form}
              name="tags"
              label="태그(선택)"
              autoComplete="off"
              description="쉼표로 구분합니다. 예: 정산, 배치"
              layout="row"
            />
            <FormRow label="읽기 전용" htmlFor={readOnlyId}>
              <Controller
                control={form.control}
                name="readOnly"
                render={({ field }) => (
                  <Field className="md:mt-2">
                    <Switch
                      id={readOnlyId}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                    <FieldDescription>
                      켜 두면 쓰기 권한이 있어도 이 접속의 스케줄러에서는 조회만 합니다. 쓰기 권한이
                      없는 계정은 감지할 때 자동으로 읽기 전용이 됩니다.
                    </FieldDescription>
                  </Field>
                )}
              />
            </FormRow>
          </FormRows>
        </CardContent>
      </Card>

      <FormActions>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          취소
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : null}
          {editing ? '변경 사항 저장하기' : '접속 추가하기'}
        </Button>
      </FormActions>
    </form>
  );
}
