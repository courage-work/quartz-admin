import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { SchedulerSettingsView } from './settings-view';

export const metadata: Metadata = { title: '스케줄러 설정' };

/** 정적 export에서 `useSearchParams`를 쓰려면 Suspense 경계가 필요하다 */
export default function SchedulerSettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <SchedulerSettingsView />
    </Suspense>
  );
}
