'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type ResetPasswordRequest, resetPasswordRequestSchema, type UserDto } from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheckIcon,
  CircleOffIcon,
  KeyRoundIcon,
  LockIcon,
  MoreHorizontalIcon,
  SearchXIcon,
  ShieldIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { FormAlert } from '@/components/form/form-alert';
import { TextField } from '@/components/form/text-field';
import { ListSearch } from '@/components/list/list-search';
import { PaginationBar } from '@/components/schedulers/pagination-bar';
import { TableEmpty } from '@/components/table-empty';
import { TableFrame } from '@/components/table-frame';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { applyApiError } from '@/lib/form-errors';
import { CLIENT_PAGE_SIZE, matchesQuery, paginate } from '@/lib/paging';

import { USERS_KEY } from './users-shared';

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

/**
 * 비밀번호 초기화. 입력 하나로 끝나는 짧은 작업이라 화면을 떠나지 않는 오른쪽 시트로 연다
 * (VectorLab surfaces: 10초 안쪽 작업은 slide-over).
 */
/** 메뉴 항목으로 연 오버레이는 닫힌 뒤 그 행의 관리 버튼으로 포커스를 돌려준다 */
function focusUserMenu(id: number | undefined): (e: Event) => void {
  return (e) => {
    const target = document.querySelector<HTMLElement>(`[data-user-menu="${id}"]`);
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };
}

function ResetPasswordSheet({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  // 닫히는 동안 user는 이미 null이므로 마지막 대상을 기억해 포커스를 돌려준다
  const lastId = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (user) lastId.current = user.id;
  }, [user]);
  const form = useForm<ResetPasswordRequest>({
    mode: 'onSubmit',
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
    <Sheet
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) {
          form.reset();
          onClose();
        }
      }}
    >
      <SheetContent side="right" onCloseAutoFocus={(e) => focusUserMenu(lastId.current)(e)}>
        <form
          noValidate
          className="flex h-full flex-col"
          onSubmit={(e) =>
            void form.handleSubmit((body) => user && reset.mutate({ id: user.id, body }))(e)
          }
        >
          <SheetHeader>
            <SheetTitle>{user?.username} 비밀번호 초기화</SheetTitle>
            <SheetDescription>
              초기화하면 잠금이 풀리고 이 사용자의 모든 로그인이 끊깁니다.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-4 px-4">
            <FormAlert message={form.formState.errors.root?.message} />
            <TextField
              form={form}
              name="password"
              label="새 비밀번호"
              type="password"
              autoComplete="new-password"
              autoFocus
              description="8자 이상"
            />
          </div>
          <SheetFooter>
            <Button type="submit" disabled={reset.isPending}>
              {reset.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
              비밀번호 초기화하기
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              취소
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${user.username} 관리하기`}
              data-user-menu={user.id}
            >
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{user.username} 관리하기</TooltipContent>
      </Tooltip>
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
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [resetting, setResetting] = useState<UserDto | null>(null);
  const [deactivating, setDeactivating] = useState<UserDto | null>(null);
  const lastDeactivating = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (deactivating) lastDeactivating.current = deactivating.id;
  }, [deactivating]);

  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: ({ signal }) => api<UserDto[]>('/users', { signal }),
    enabled: me.isAdmin,
  });

  // 기본 정렬: 아이디순
  const paged = paginate(
    (users.data ?? [])
      .filter((u) => matchesQuery(q, [u.username]))
      .sort((a, b) => a.username.localeCompare(b.username)),
    page,
  );

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
          <Button asChild>
            <Link href="/users/new">
              <UserPlusIcon data-icon="inline-start" aria-hidden />
              사용자 추가
            </Link>
          </Button>
        }
      />

      {users.isError ? (
        <FormAlert error={users.error} />
      ) : (
        <>
          <ListSearch
            label="검색(아이디)"
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            className="max-w-md"
          />
          <TableFrame>
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
                {users.isPending ? (
                  Array.from({ length: 3 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : paged.items.length === 0 ? (
                  // 검색하지 않았는데 검색 문구를 보이지 않는다
                  q.trim() ? (
                    <TableEmpty
                      colSpan={6}
                      icon={SearchXIcon}
                      title="검색어에 맞는 사용자가 없습니다"
                      action={
                        <Button variant="outline" onClick={() => setQ('')}>
                          검색어 지우기
                        </Button>
                      }
                    />
                  ) : (
                    <TableEmpty colSpan={6} icon={UsersIcon} title="아직 사용자가 없습니다" />
                  )
                ) : (
                  paged.items.map((user) => (
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
                  ))
                )}
              </TableBody>
            </Table>
          </TableFrame>
          <PaginationBar
            page={paged.page}
            size={CLIENT_PAGE_SIZE}
            total={paged.total}
            onPageChange={setPage}
          />
        </>
      )}

      <ResetPasswordSheet user={resetting} onClose={() => setResetting(null)} />
      <AlertDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
      >
        <AlertDialogContent onCloseAutoFocus={(e) => focusUserMenu(lastDeactivating.current)(e)}>
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
