'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, LogOutIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { LOGIN_PATH } from '@/lib/navigation';

/** 헤더 오른쪽의 본인 메뉴: 비밀번호 변경, 로그아웃 */
export function UserMenu() {
  const user = useCurrentUser();
  const router = useRouter();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST', skipAuthRedirect: true }),
    onSuccess: () => {
      queryClient.clear();
      router.replace(LOGIN_PATH);
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost">
          <UserIcon data-icon="inline-start" aria-hidden />
          {user.username}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{user.isAdmin ? '관리자' : '사용자'}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <KeyRoundIcon aria-hidden />
            비밀번호 변경
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate()}>
          <LogOutIcon aria-hidden />
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
