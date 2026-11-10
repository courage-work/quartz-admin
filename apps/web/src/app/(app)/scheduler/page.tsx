import type { Metadata } from 'next';
import { Suspense } from 'react';

import { WidePage } from '@/components/shell/wide-page';
import { Skeleton } from '@/components/ui/skeleton';

import { SchedulerView } from './scheduler-view';

export const metadata: Metadata = { title: '스케줄러' };

/** 정적 export에서 `useSearchParams`를 쓰려면 Suspense 경계가 필요하다 */
export default function SchedulerPage() {
  return (
    <>
      {/* 트리거 표는 열이 많아 본문 폭을 넓힌다 */}
      <WidePage />
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <SchedulerView />
      </Suspense>
    </>
  );
}
