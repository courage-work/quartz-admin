import type { Metadata } from 'next';

import { ConnectionsView } from './connections-view';

export const metadata: Metadata = { title: '접속' };

export default function ConnectionsPage() {
  return <ConnectionsView />;
}
