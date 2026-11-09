import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { ConnectionsView } from './connections-view';

export const metadata: Metadata = { title: '접속' };

/** 검색어·쪽을 주소에 두므로(`useSearchParams`) 정적 export에서 Suspense 경계가 필요하다 */
export default function ConnectionsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ConnectionsView />
    </Suspense>
  );
}
