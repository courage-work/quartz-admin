import type { Metadata } from 'next';

import { ChannelsView } from './channels-view';

export const metadata: Metadata = { title: '알림 채널' };

export default function ChannelsPage() {
  return <ChannelsView />;
}
