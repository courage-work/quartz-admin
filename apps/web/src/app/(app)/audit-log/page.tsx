import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { AuditLogDetail } from './audit-log-detail';

export const metadata: Metadata = { title: '감사 기록' };

/** 정적 export에서 `useSearchParams`를 쓰려면 Suspense 경계가 필요하다 */
export default function AuditLogPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <AuditLogDetail />
    </Suspense>
  );
}
