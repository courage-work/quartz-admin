import type { Metadata } from 'next';

import { UsersView } from './users-view';

export const metadata: Metadata = { title: '사용자' };

export default function UsersPage() {
  return <UsersView />;
}
