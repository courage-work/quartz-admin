import type { Metadata } from 'next';

import { AccountView } from './change-password';

export const metadata: Metadata = { title: '내 계정' };

export default function AccountPage() {
  return <AccountView />;
}
