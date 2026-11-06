'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { isApiError } from '@/lib/api';
import { CurrentUserProvider, useMeQuery } from '@/lib/auth';
import { loginHref } from '@/lib/navigation';

/**
 * 로그인한 사용자만 안쪽을 보여 준다. 세션이 없으면 지금 경로를 `next`로 붙여 로그인 화면으로 보낸다.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useMeQuery();
  const unauthenticated = isApiError(me.error, 'UNAUTHENTICATED');

  useEffect(() => {
    if (unauthenticated) {
      router.replace(loginHref(window.location.pathname, window.location.search));
    }
  }, [unauthenticated, router]);

  if (me.data) return <CurrentUserProvider user={me.data}>{children}</CurrentUserProvider>;

  if (me.isError && !unauthenticated) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>로그인 상태를 확인하지 못했습니다</EmptyTitle>
            <EmptyDescription>{me.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void me.refetch()}>다시 시도하기</Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center" aria-busy="true">
      <Spinner aria-label="로그인 상태를 확인하는 중" />
    </div>
  );
}
