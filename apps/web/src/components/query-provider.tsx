'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { isApiError, setUnauthenticatedHandler } from '@/lib/api';
import { LOGIN_PATH, loginHref } from '@/lib/navigation';

/** 4xx는 다시 시도해도 같으므로 재시도하지 않는다 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.isClientError) return false;
  return failureCount < 2;
}

/**
 * TanStack Query 공급자. 세션이 만료된 응답을 받으면 캐시를 비우고,
 * 지금 화면으로 돌아오도록 `next`를 붙여 로그인 화면으로 보낸다.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: shouldRetry, staleTime: 10_000 },
          mutations: { retry: false },
        },
      }),
  );

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      if (window.location.pathname === LOGIN_PATH) return;
      client.clear();
      toast.warning('세션이 만료됐습니다. 다시 로그인하세요');
      router.replace(loginHref(window.location.pathname, window.location.search));
    });
    return () => setUnauthenticatedHandler(undefined);
  }, [client, router]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
