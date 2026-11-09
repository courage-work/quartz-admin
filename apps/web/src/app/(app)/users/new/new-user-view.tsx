'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createUserRequestSchema, type UserDto } from '@qa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { FormActions } from '@/components/form/form-actions';
import { FormAlert } from '@/components/form/form-alert';
import { FormRow, FormRows } from '@/components/form/form-row';
import { TextField } from '@/components/form/text-field';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { applyApiError } from '@/lib/form-errors';

import { USERS_KEY } from '../users-shared';

const formSchema = createUserRequestSchema.extend({ isAdmin: z.boolean() });
type FormValues = z.infer<typeof formSchema>;

/**
 * 사용자 추가 (`/users/new`, PRD FR-USR-03). 10초 넘게 걸리는 입력이라 대화상자 대신 화면으로 둔다
 * (VectorLab surfaces). 폼 패턴: 좁은 한 단, 라벨은 입력 위, 아래에 취소·추가 버튼.
 */
export function NewUserView() {
  const me = useCurrentUser();
  const router = useRouter();
  const queryClient = useQueryClient();
  const adminId = useId();
  const form = useForm<FormValues>({
    mode: 'onSubmit',
    resolver: zodResolver(formSchema),
    defaultValues: { username: '', password: '', isAdmin: false },
  });
  const create = useMutation({
    mutationFn: (body: FormValues) => api<UserDto>('/users', { method: 'POST', body }),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(`${user.username} 사용자를 추가했습니다`);
      router.push('/users');
    },
    onError: (err) =>
      applyApiError(err, form.setError, { USERNAME_TAKEN: 'username' }, ['username', 'password']),
  });

  if (!me.isAdmin) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>관리자만 사용할 수 있습니다</EmptyTitle>
          <EmptyDescription>사용자 추가가 필요하면 관리자에게 요청하세요.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <PageHeader
        trail={[{ label: '사용자', href: '/users' }]}
        title="사용자 추가"
        description="처음 쓸 비밀번호를 정해 전달하세요. 사용자는 로그인한 뒤 직접 바꿀 수 있습니다."
      />
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(e) => void form.handleSubmit((values) => create.mutate(values))(e)}
      >
        <FormAlert message={form.formState.errors.root?.message} />
        {/* 다른 추가·수정 화면과 같은 라벨 칸(1/4) 구성 (B-40) */}
        <Card>
          <CardHeader>
            <CardTitle>계정</CardTitle>
          </CardHeader>
          <CardContent>
            <FormRows>
              <TextField
                form={form}
                name="username"
                label="아이디"
                autoComplete="off"
                autoFocus
                description="영문 소문자, 숫자, ., _, @, -로 3~64자"
                layout="row"
              />
              <TextField
                form={form}
                name="password"
                label="초기 비밀번호"
                type="password"
                autoComplete="new-password"
                description="8자 이상"
                layout="row"
              />
              <FormRow label="권한">
                <Controller
                  control={form.control}
                  name="isAdmin"
                  render={({ field }) => (
                    <Field orientation="horizontal" className="md:mt-2">
                      <Checkbox
                        id={adminId}
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                      <FieldLabel htmlFor={adminId}>관리자 권한 주기 (선택)</FieldLabel>
                    </Field>
                  )}
                />
              </FormRow>
            </FormRows>
          </CardContent>
        </Card>
        <FormActions>
          <Button asChild variant="outline">
            <Link href="/users">취소</Link>
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
            사용자 추가하기
          </Button>
        </FormActions>
      </form>
    </>
  );
}
