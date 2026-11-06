'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { APP_NAME, type LoginRequest, loginRequestSchema, type MeResponse } from '@qa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClockIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import { FormAlert } from '@/components/form/form-alert';
import { TextField } from '@/components/form/text-field';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { ME_QUERY_KEY, useMeQuery } from '@/lib/auth';
import { applyApiError } from '@/lib/form-errors';
import { safeNextPath } from '@/lib/navigation';

function nextPath(): string {
  return safeNextPath(new URLSearchParams(window.location.search).get('next'));
}

export function LoginForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMeQuery();
  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { username: '', password: '' },
  });

  // 이미 로그인돼 있으면 바로 돌려보낸다
  useEffect(() => {
    if (me.data) router.replace(nextPath());
  }, [me.data, router]);

  const login = useMutation({
    mutationFn: (body: LoginRequest) =>
      api<MeResponse>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
    onSuccess: (user) => {
      queryClient.setQueryData(ME_QUERY_KEY, user);
      router.replace(nextPath());
    },
    onError: (err) => {
      form.resetField('password');
      applyApiError(err, form.setError);
    },
  });

  return (
    <div className="flex min-h-svh flex-col">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-start justify-center px-6 pt-16">
        <div className="w-full max-w-sm">
          <Card>
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <CalendarClockIcon aria-hidden />
                  {APP_NAME}
                </span>
              </CardTitle>
              <CardDescription>계정 아이디와 비밀번호로 로그인하세요.</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                noValidate
                onSubmit={(e) => void form.handleSubmit((values) => login.mutate(values))(e)}
              >
                <FieldGroup>
                  <FormAlert message={form.formState.errors.root?.message} />
                  <TextField
                    form={form}
                    name="username"
                    label="아이디"
                    autoComplete="username"
                    autoFocus
                  />
                  <TextField
                    form={form}
                    name="password"
                    label="비밀번호"
                    type="password"
                    autoComplete="current-password"
                  />
                  <Button type="submit" disabled={login.isPending}>
                    {login.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
                    로그인하기
                  </Button>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            비밀번호를 잊었으면 관리자에게 초기화를 요청하세요.
          </p>
        </div>
      </main>
    </div>
  );
}
