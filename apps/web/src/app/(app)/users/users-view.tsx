'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createUserRequestSchema,
  type ResetPasswordRequest,
  resetPasswordRequestSchema,
  type UserDto,
} from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheckIcon,
  CircleOffIcon,
  KeyRoundIcon,
  LockIcon,
  MoreHorizontalIcon,
  ShieldIcon,
  UserPlusIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { FormAlert } from '@/components/form/form-alert';
import { TextField } from '@/components/form/text-field';
import { PageHeader } from '@/components/shell/page-header';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { applyApiError } from '@/lib/form-errors';

const USERS_KEY = ['users'] as const;

const createFormSchema = createUserRequestSchema.extend({ isAdmin: z.boolean() });
type CreateFormValues = z.infer<typeof createFormSchema>;

function UserStatusBadge({ user }: { user: UserDto }) {
  if (!user.isActive) {
    return (
      <Badge variant="neutral">
        <CircleOffIcon data-icon="inline-start" aria-hidden />
        비활성
      </Badge>
    );
  }
  if (user.lockedUntil !== null) {
    return (
      <Badge variant="warning" title={`${formatDateTime(user.lockedUntil)}까지`}>
        <LockIcon data-icon="inline-start" aria-hidden />
        잠김
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <CircleCheckIcon data-icon="inline-start" aria-hidden />
      활성
    </Badge>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createFormSchema),
    defaultValues: { username: '', password: '', isAdmin: false },
  });
  const create = useMutation({
    mutationFn: (body: CreateFormValues) => api<UserDto>('/users', { method: 'POST', body }),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(`${user.username} 사용자를 추가했습니다`);
      form.reset();
      onOpenChange(false);
    },
    onError: (err) =>
      applyApiError(err, form.setError, { USERNAME_TAKEN: 'username' }, ['username', 'password']),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          noValidate
          onSubmit={(e) => void form.handleSubmit((values) => create.mutate(values))(e)}
        >
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>사용자 추가</DialogTitle>
              <DialogDescription>
                처음 쓸 비밀번호를 정해 전달하세요. 사용자는 로그인한 뒤 직접 바꿀 수 있습니다.
              </DialogDescription>
            </DialogHeader>
            <FormAlert message={form.formState.errors.root?.message} />
            <TextField
              form={form}
              name="username"
              label="아이디"
              autoComplete="off"
              description="영문 소문자, 숫자, ., _, @, -로 3~64자"
            />
            <TextField
              form={form}
              name="password"
              label="초기 비밀번호"
              type="password"
              autoComplete="new-password"
              description="8자 이상"
            />
            <Controller
              control={form.control}
              name="isAdmin"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Checkbox
                    id="create-user-admin"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                  <FieldLabel htmlFor="create-user-admin">관리자 권한 주기</FieldLabel>
                </Field>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                취소
              </Button>
              <Button type="submit" disabled={create.isPending}>
                사용자 추가하기
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const form = useForm<ResetPasswordRequest>({
    resolver: zodResolver(resetPasswordRequestSchema),
    defaultValues: { password: '' },
  });
  const reset = useMutation({
    mutationFn: ({ id, body }: { id: number; body: ResetPasswordRequest }) =>
      api<void>(`/users/${id}/reset-password`, { method: 'POST', body }),
    onSuccess: () => {
      toast.success(`${user?.username ?? ''} 비밀번호를 초기화했습니다`);
      form.reset();
      onClose();
    },
    onError: (err) => applyApiError(err, form.setError, {}, ['password']),
  });

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          noValidate
          onSubmit={(e) =>
            void form.handleSubmit((body) => user && reset.mutate({ id: user.id, body }))(e)
          }
        >
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>{user?.username} 비밀번호 초기화</DialogTitle>
              <DialogDescription>
                초기화하면 잠금이 풀리고 이 사용자의 모든 로그인이 끊깁니다.
              </DialogDescription>
            </DialogHeader>
            <FormAlert message={form.formState.errors.root?.message} />
            <TextField
              form={form}
              name="password"
              label="새 비밀번호"
              type="password"
              autoComplete="new-password"
              description="8자 이상"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                취소
              </Button>
              <Button type="submit" disabled={reset.isPending}>
                비밀번호 초기화하기
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UserActions({
  user,
  isSelf,
  onResetPassword,
  onDeactivate,
  onActivate,
}: {
  user: UserDto;
  isSelf: boolean;
  onResetPassword: () => void;
  onDeactivate: () => void;
  onActivate: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`${user.username} 관리 메뉴`}>
          <MoreHorizontalIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onResetPassword}>
          <KeyRoundIcon aria-hidden />
          비밀번호 초기화
        </DropdownMenuItem>
        {user.isActive ? (
          <DropdownMenuItem variant="destructive" disabled={isSelf} onSelect={onDeactivate}>
            <CircleOffIcon aria-hidden />
            {isSelf ? '본인 계정은 비활성화할 수 없음' : '비활성화'}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onActivate}>
            <CircleCheckIcon aria-hidden />
            다시 활성화
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 사용자 관리 (PRD FR-USR-03, 관리자 전용) */
export function UsersView() {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<UserDto | null>(null);
  const [deactivating, setDeactivating] = useState<UserDto | null>(null);

  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: ({ signal }) => api<UserDto[]>('/users', { signal }),
    enabled: me.isAdmin,
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api<UserDto>(`/users/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(
        user.isActive
          ? `${user.username} 사용자를 다시 활성화했습니다`
          : `${user.username} 사용자를 비활성화했습니다. 로그인이 모두 끊겼습니다`,
      );
      setDeactivating(null);
    },
    onError: (err) => toast.error(err.message),
  });

  if (!me.isAdmin) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>관리자만 사용할 수 있습니다</EmptyTitle>
          <EmptyDescription>
            사용자 추가나 비밀번호 초기화가 필요하면 관리자에게 요청하세요.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <PageHeader
        title="사용자"
        description="로그인한 사용자는 모두 조회와 제어를 할 수 있습니다. 사용자 관리만 관리자 전용입니다."
        actions={
          <Button onClick={() => setCreating(true)}>
            <UserPlusIcon data-icon="inline-start" aria-hidden />
            사용자 추가
          </Button>
        }
      />

      {users.isError ? (
        <FormAlert message={users.error.message} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>아이디</TableHead>
              <TableHead>권한</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>마지막 로그인</TableHead>
              <TableHead>만든 날</TableHead>
              <TableHead>
                <span className="sr-only">관리</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isPending
              ? Array.from({ length: 3 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : users.data.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <span className="font-mono">{user.username}</span>
                      {user.id === me.id ? (
                        <span className="ml-2 text-xs text-muted-foreground">(나)</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.isAdmin ? 'info' : 'neutral'}>
                        {user.isAdmin ? '관리자' : '사용자'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <UserStatusBadge user={user} />
                    </TableCell>
                    <TableCell>{formatDateTime(user.lastLoginAt)}</TableCell>
                    <TableCell>{formatDateTime(user.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <UserActions
                          user={user}
                          isSelf={user.id === me.id}
                          onResetPassword={() => setResetting(user)}
                          onDeactivate={() => setDeactivating(user)}
                          onActivate={() => setActive.mutate({ id: user.id, isActive: true })}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      )}

      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
      <AlertDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deactivating?.username} 사용자를 비활성화할까요?</AlertDialogTitle>
            <AlertDialogDescription>
              이 사용자는 더 이상 로그인할 수 없고, 지금 로그인한 세션도 모두 끊깁니다. 나중에 다시
              활성화할 수 있습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={setActive.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deactivating) setActive.mutate({ id: deactivating.id, isActive: false });
              }}
            >
              {deactivating?.username} 비활성화
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
