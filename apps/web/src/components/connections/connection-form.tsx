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
import { CircleCheckIcon, CircleXIcon, PlugZapIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Controller, type Resolver, useForm, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { FormAlert } from '@/components/form/form-alert';
import { TextField } from '@/components/form/text-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
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
import { applyApiError } from '@/lib/form-errors';

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
  const oracleNameError = form.getFieldState('oracleName', form.formState).error;
  const dbTypeError = form.getFieldState('dbType', form.formState).error;

  return (
    <FieldGroup>
      <Controller
        control={form.control}
        name="dbType"
        render={({ field }) => (
          <Field data-invalid={dbTypeError ? true : undefined}>
            <FieldLabel htmlFor={dbTypeId}>DB 종류</FieldLabel>
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
              <SelectTrigger id={dbTypeId} className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DB_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind} disabled={!SUPPORTED_DB_KINDS.includes(kind)}>
                    {DB_KIND_LABELS[kind]}
                    {SUPPORTED_DB_KINDS.includes(kind) ? '' : ' (지원 예정)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError errors={[dbTypeError]} />
          </Field>
        )}
      />
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="sm:col-span-3">
          <TextField form={form} name="host" label="호스트" autoComplete="off" />
        </div>
        <TextField form={form} name="port" label="포트" autoComplete="off" />
      </div>
      {dbType === 'oracle' ? (
        <Field data-invalid={oracleNameError ? true : undefined}>
          <FieldLabel id={oracleModeId}>접속 방식</FieldLabel>
          <Controller
            control={form.control}
            name="oracleMode"
            render={({ field }) => (
              <RadioGroup
                aria-labelledby={oracleModeId}
                value={field.value}
                onValueChange={field.onChange}
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
          <TextField
            form={form}
            name="oracleName"
            label={oracleMode === 'sid' ? 'SID' : '서비스 이름'}
            autoComplete="off"
            description={oracleMode === 'sid' ? '예: ORCL' : '예: ORCLPDB1'}
          />
        </Field>
      ) : (
        <TextField form={form} name="database" label="DB 이름" autoComplete="off" />
      )}
      <TextField
        form={form}
        name="schemaName"
        label="스키마(선택)"
        autoComplete="off"
        description="Quartz 테이블이 있는 스키마입니다. 비워 두면 접속 계정의 기본 스키마를 봅니다."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="username" label="계정" autoComplete="off" />
        <TextField
          form={form}
          name="password"
          label="비밀번호"
          type="password"
          autoComplete="new-password"
          description={editing ? '비워 두면 저장된 비밀번호를 그대로 씁니다.' : undefined}
        />
      </div>
    </FieldGroup>
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
    resolver: schemaResolver(
      editing ? updateConnectionRequestSchema : createConnectionRequestSchema,
    ),
    defaultValues: connection ? connectionFormValues(connection) : EMPTY_CONNECTION_FORM,
  });

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
      className="flex max-w-3xl flex-col gap-6"
      onSubmit={(e) => void form.handleSubmit((values) => save.mutate(values))(e)}
    >
      <FormAlert message={form.formState.errors.root?.message} />
      <Card>
        <CardHeader>
          <CardTitle>대상 DB</CardTitle>
          <CardDescription>
            Quartz 테이블이 있는 DB에 붙을 정보입니다. 비밀번호는 암호화해 저장하고 화면에 다시 보여
            주지 않습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-6">
            <TargetFields form={form} editing={editing} />
            <div className="flex flex-col gap-3">
              <div>
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
              </div>
              {testResult ? <TestResult result={testResult} /> : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>표시와 분류</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <TextField
              form={form}
              name="name"
              label="접속 이름"
              autoComplete="off"
              description="목록과 감사 로그에 보이는 이름입니다."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                form={form}
                name="envLabel"
                label="환경 라벨"
                autoComplete="off"
                description="prod, stage, dev처럼 씁니다. prod는 화면에 빨갛게 표시됩니다."
              />
              <TextField
                form={form}
                name="tags"
                label="태그(선택)"
                autoComplete="off"
                description="쉼표로 구분합니다. 예: 정산, 배치"
              />
            </div>
            <FieldSet>
              <FieldLegend variant="label">권한</FieldLegend>
              <Controller
                control={form.control}
                name="readOnly"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <Switch
                      id={readOnlyId}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                    <FieldLabel htmlFor={readOnlyId}>읽기 전용으로 쓰기</FieldLabel>
                  </Field>
                )}
              />
              <FieldDescription>
                켜 두면 쓰기 권한이 있어도 이 접속의 스케줄러에서는 조회만 합니다. 쓰기 권한이 없는
                계정은 감지할 때 자동으로 읽기 전용이 됩니다.
              </FieldDescription>
            </FieldSet>
          </FieldGroup>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : null}
          {editing ? '변경 사항 저장하기' : '접속 추가하기'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          취소
        </Button>
      </div>
    </form>
  );
}
