'use client';

import type { ChannelsResponse } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { ChannelForm } from '@/components/channels/channel-form';
import { FormAlert } from '@/components/form/form-alert';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { CHANNELS_KEY } from '@/lib/channels';
import { parseId } from '@/lib/navigation';
import { usePageTitle } from '@/lib/page-title';

/** 알림 채널 수정 (`/channel/edit?id=N`, FR-ALT-07). 인앱 채널은 바꿀 수 없다 */
export function EditChannelView() {
  const id = parseId(useSearchParams().get('id'));
  const res = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: ({ signal }) => api<ChannelsResponse>('/channels', { signal }),
  });
  const channel = res.data?.channels.find((c) => c.id === id && c.type !== 'inapp');
  usePageTitle(channel ? `${channel.name} 수정` : '알림 채널 수정');
  return (
    <>
      <PageHeader trail={[{ label: '알림 채널', href: '/channels' }]} title="알림 채널 수정" />
      {res.isError ? (
        <FormAlert error={res.error} />
      ) : !res.data ? (
        <Skeleton className="h-64 w-full" />
      ) : !channel ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>알림 채널을 찾을 수 없습니다</EmptyTitle>
            <EmptyDescription>주소가 잘못됐거나 이미 삭제했습니다.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link href="/channels">알림 채널로 가기</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ChannelForm key={channel.id} channel={channel} smtpConfigured={res.data.smtpConfigured} />
      )}
    </>
  );
}
