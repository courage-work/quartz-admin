import type { Metadata } from 'next';

import { WidePage } from '@/components/shell/wide-page';

import { AlertsView } from './alerts-view';

export const metadata: Metadata = { title: '알림 센터' };

export default function AlertsPage() {
  return (
    <>
      <WidePage />
      <AlertsView />
    </>
  );
}
