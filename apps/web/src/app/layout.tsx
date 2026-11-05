import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { APP_NAME } from '@qa/shared';

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Quartz Scheduler 클러스터 관리 도구',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
