'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordRequestSchema } from '@qa/shared';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { FormAlert } from '@/components/form/form-alert';
import { TextField } from '@/components/form/text-field';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { applyApiError } from '@/lib/form-errors';

const formSchema = changePasswordRequestSchema
  .extend({ confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, {
    error: '새 비밀번호와 같게 입력하세요',
    path: ['confirmPassword'],
  });
type FormValues = z.infer<typeof formSchema>;

/** 본인 계정 정보와 비밀번호 변경 (PRD FR-USR-05) */
export function AccountView() {
  const user = useCurrentUser();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const change = useMutation({
    mutationFn: ({ currentPassword, newPassword }: FormValues) =>
      api<void>('/auth/password', { method: 'PUT', body: { currentPassword, newPassword } }),
    onSuccess: () => {
      form.reset();
      toast.success('비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊겼습니다');
    },
    onError: (err) =>
      applyApiError(err, form.setError, { WRONG_PASSWORD: 'currentPassword' }, [
        'currentPassword',
        'newPassword',
      ]),
  });

  return (
    <>
      <PageHeader title="내 계정" />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>계정 정보</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-3 gap-y-3 text-sm">
              <dt className="text-muted-foreground">아이디</dt>
              <dd className="col-span-2 font-mono">{user.username}</dd>
              <dt className="text-muted-foreground">권한</dt>
              <dd className="col-span-2">
                <Badge variant={user.isAdmin ? 'info' : 'neutral'}>
                  {user.isAdmin ? '관리자' : '사용자'}
                </Badge>
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>비밀번호 변경</CardTitle>
            <CardDescription>바꾸면 지금 쓰는 기기를 뺀 나머지 로그인이 끊깁니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              noValidate
              onSubmit={(e) => void form.handleSubmit((values) => change.mutate(values))(e)}
            >
              <FieldGroup>
                <FormAlert message={form.formState.errors.root?.message} />
                <TextField
                  form={form}
                  name="currentPassword"
                  label="현재 비밀번호"
                  type="password"
                  autoComplete="current-password"
                />
                <TextField
                  form={form}
                  name="newPassword"
                  label="새 비밀번호"
                  type="password"
                  autoComplete="new-password"
                  description="8자 이상으로 입력하세요."
                />
                <TextField
                  form={form}
                  name="confirmPassword"
                  label="새 비밀번호 확인"
                  type="password"
                  autoComplete="new-password"
                />
                <div>
                  <Button type="submit" disabled={change.isPending}>
                    비밀번호 바꾸기
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
