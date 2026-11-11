import type { Metadata } from 'next';

import { NewChannelView } from './new-channel-view';

export const metadata: Metadata = { title: '알림 채널 추가' };

export default function NewChannelPage() {
  return <NewChannelView />;
}
