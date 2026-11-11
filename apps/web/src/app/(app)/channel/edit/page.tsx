import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { EditChannelView } from './edit-channel-view';

export const metadata: Metadata = { title: '알림 채널 수정' };

/** 정적 export에서 `useSearchParams`를 쓰려면 Suspense 경계가 필요하다 */
export default function EditChannelPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <EditChannelView />
    </Suspense>
  );
}
