'use client';

import type { MeResponse } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';

import { api } from '@/lib/api';

export const ME_QUERY_KEY = ['auth', 'me'] as const;

/**
 * 로그인한 본인 정보. 화면의 인증 확인은 여기서만 하고, 실제 접근 통제는 API가 한다 (TRD §2.2).
 * 401은 로그인 화면 이동 대신 오류로 돌려준다(`AuthGate`가 처리).
 */
export function useMeQuery() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => api<MeResponse>('/auth/me', { signal, skipAuthRedirect: true }),
    staleTime: 60_000,
    retry: false,
  });
}

const CurrentUserContext = createContext<MeResponse | null>(null);

export function CurrentUserProvider({ user, children }: { user: MeResponse; children: ReactNode }) {
  return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

/** `AuthGate` 안에서만 쓴다 */
export function useCurrentUser(): MeResponse {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error('useCurrentUser는 AuthGate 안에서 써야 합니다');
  return user;
}
