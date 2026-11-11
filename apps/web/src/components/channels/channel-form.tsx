'use client';

import { type ChannelDto, channelInputSchema, type ChannelInput } from '@qa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId } from 'react';
import {
  Controller,
  type FieldErrors,
  type Resolver,
  useForm,
  type UseFormReturn,
  useWatch,
} from 'react-hook-form';
import { toast } from 'sonner';

import { FormActions } from '@/components/form/form-actions';
import { FormAlert } from '@/components/form/form-alert';
import { FormRow, FormRows } from '@/components/form/form-row';
import { TextField } from '@/components/form/text-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import {
  CHANNEL_TYPE_LABELS,
  CHANNELS_KEY,
  channelFormPathOf,
  type ChannelFormValues,
  channelFormValues,
  toChannelRequest,
} from '@/lib/channels';
import { applyApiError } from '@/lib/form-errors';

type Form = UseFormReturn<ChannelFormValues>;

/** 추가에서는 웹훅 URL이 필수다(수정에서 비우면 지금 값을 쓴다) */
function channelResolver(creating: boolean): Resolver<ChannelFormValues> {
  return (values) => {
    const parsed = channelInputSchema.safeParse(toChannelRequest(values));
    const errors: Record<string, { type: string; message: string }> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = channelFormPathOf(issue.path);
        if (path) errors[path] ??= { type: 'validate', message: issue.message };
      }
    }
    if (creating && values.type === 'slack' && !values.webhookUrl.trim()) {
      errors.webhookUrl ??= { type: 'required', message: '웹훅 URL을 입력하세요' };
    }
    return Object.keys(errors).length === 0
      ? { values, errors: {} }
      : { values: {}, errors: errors as FieldErrors<ChannelFormValues> };
  };
}

function WebhookField({ form, channel }: { form: Form; channel?: ChannelDto }) {
  const id = useId();
  const error = form.formState.errors.webhookUrl;
  return (
    <FormRow label="웹훅 URL" htmlFor={id} invalid={!!error}>
      <Field data-invalid={error ? true : undefined}>
        <Input
          id={id}
          type="password"
          mono
          autoComplete="off"
          className="md:max-w-xl"
          aria-invalid={error ? true : undefined}
          {...form.register('webhookUrl')}
        />
        <FieldDescription>
          {channel
            ? `지금 값: ${channel.target}. 바꿀 때만 입력하세요. 비우면 그대로 둡니다.`
            : 'Slack 앱의 Incoming Webhooks에서 만든 https:// 주소입니다. 암호화해 저장하고 다시 보여 주지 않습니다.'}
        </FieldDescription>
        <FieldError errors={[error]} />
      </Field>
    </FormRow>
  );
}

function RecipientsField({ form }: { form: Form }) {
  const id = useId();
  const error = form.formState.errors.recipients;
  return (
    <FormRow label="받는 사람" htmlFor={id} invalid={!!error}>
      <Field data-invalid={error ? true : undefined}>
        <Textarea
          id={id}
          rows={3}
          className="md:max-w-xl"
          aria-invalid={error ? true : undefined}
          {...form.register('recipients')}
        />
        <FieldDescription>줄마다(또는 쉼표로) 이메일 주소 하나. 20명까지입니다.</FieldDescription>
        <FieldError errors={[error]} />
      </Field>
    </FormRow>
  );
}

/**
 * 알림 채널 추가·수정 폼 (FR-ALT-07). 종류(Slack, 이메일)는 추가할 때만 고른다.
 * 저장·취소 뒤 채널 목록으로 돌아간다.
 */
export function ChannelForm({
  channel,
  smtpConfigured,
}: {
  channel?: ChannelDto;
  smtpConfigured: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const typeId = useId();
  const enabledId = useId();
  const form = useForm<ChannelFormValues>({
    mode: 'onSubmit',
    resolver: channelResolver(!channel),
    defaultValues: channelFormValues(channel),
  });
  const type = useWatch({ control: form.control, name: 'type' });
  const save = useMutation({
    mutationFn: (body: ChannelInput) =>
      channel
        ? api<ChannelDto>(`/channels/${channel.id}`, { method: 'PUT', body })
        : api<ChannelDto>('/channels', { method: 'POST', body }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
      toast.success(`${saved.name} 채널을 ${channel ? '저장했습니다' : '추가했습니다'}`);
      router.push('/channels');
    },
    onError: (err) =>
      applyApiError(err, form.setError, {}, ['name', 'webhookUrl', 'recipients', 'type']),
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) =>
        void form.handleSubmit((v) => save.mutate(channelInputSchema.parse(toChannelRequest(v))))(e)
      }
    >
      <FormAlert message={form.formState.errors.root?.message} />
      {type === 'email' && !smtpConfigured ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>SMTP를 설정하지 않았습니다</AlertTitle>
          <AlertDescription>
            채널은 저장할 수 있지만 보내지 못합니다. 서버에 QA_SMTP_HOST와 QA_SMTP_FROM을
            설정하세요.
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>채널</CardTitle>
          <CardDescription>
            알림 규칙에서 이 채널을 고르면 그 규칙의 알림이 여기로 갑니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormRows>
            {channel ? (
              <FormRow label="종류">
                <p className="md:pt-2">{CHANNEL_TYPE_LABELS[channel.type]}</p>
              </FormRow>
            ) : (
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormRow label="종류" labelId={typeId}>
                    <RadioGroup
                      aria-labelledby={typeId}
                      value={field.value}
                      onValueChange={field.onChange}
                      className="md:mt-2"
                    >
                      {(['slack', 'email'] as const).map((t) => (
                        <Field key={t} orientation="horizontal">
                          <RadioGroupItem id={`${typeId}-${t}`} value={t} />
                          <FieldLabel htmlFor={`${typeId}-${t}`}>
                            {CHANNEL_TYPE_LABELS[t]}
                          </FieldLabel>
                        </Field>
                      ))}
                    </RadioGroup>
                  </FormRow>
                )}
              />
            )}
            <TextField
              form={form}
              name="name"
              label="이름"
              autoComplete="off"
              description="규칙에서 고를 때 보이는 이름입니다. 예: 배치 운영 Slack"
              layout="row"
            />
            {type === 'slack' ? (
              <WebhookField form={form} {...(channel ? { channel } : {})} />
            ) : (
              <RecipientsField form={form} />
            )}
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormRow label="사용" htmlFor={enabledId}>
                  <div className="md:pt-2">
                    <Field orientation="horizontal">
                      <Switch
                        id={enabledId}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                      <FieldDescription>
                        끄면 이 채널로 보내지 않고, 아직 보내지 못한 알림도 버립니다.
                      </FieldDescription>
                    </Field>
                  </div>
                </FormRow>
              )}
            />
          </FormRows>
        </CardContent>
      </Card>
      <FormActions>
        <Button asChild variant="outline">
          <Link href="/channels">취소</Link>
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
          {channel ? '채널 저장하기' : '채널 추가하기'}
        </Button>
      </FormActions>
    </form>
  );
}
