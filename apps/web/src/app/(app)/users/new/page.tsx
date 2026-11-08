import type { Metadata } from 'next';

import { NewUserView } from './new-user-view';

export const metadata: Metadata = { title: '사용자 추가' };

export default function NewUserPage() {
  return <NewUserView />;
}
