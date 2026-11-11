'use client';

import type { ChannelsResponse } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';

import { ChannelForm } from '@/components/channels/channel-form';
import { FormAlert } from '@/components/form/form-alert';
import { PageHeader } from '@/components/shell/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { CHANNELS_KEY } from '@/lib/channels';
import { usePageTitle } from '@/lib/page-title';

/** 알림 채널 추가 (`/channels/new`, FR-ALT-07) */
export function NewChannelView() {
  usePageTitle('알림 채널 추가');
  const res = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: ({ signal }) => api<ChannelsResponse>('/channels', { signal }),
  });
  return (
    <>
      <PageHeader trail={[{ label: '알림 채널', href: '/channels' }]} title="알림 채널 추가" />
      {res.isError ? (
        <FormAlert error={res.error} />
      ) : !res.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <ChannelForm smtpConfigured={res.data.smtpConfigured} />
      )}
    </>
  );
}
