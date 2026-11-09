import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { AuditLogsView } from './audit-logs-view';

export const metadata: Metadata = { title: '감사 로그' };

/** 필터를 주소에 두므로(`useSearchParams`) 정적 export에서 Suspense 경계가 필요하다 */
export default function AuditLogsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <AuditLogsView />
    </Suspense>
  );
}
