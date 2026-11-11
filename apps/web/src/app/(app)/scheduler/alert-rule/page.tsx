import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { AlertRuleView } from './alert-rule-view';

export const metadata: Metadata = { title: '알림 규칙' };

/** 정적 export에서 `useSearchParams`를 쓰려면 Suspense 경계가 필요하다 */
export default function AlertRulePage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <AlertRuleView />
    </Suspense>
  );
}
