import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import 'd2coding/d2coding-subset.css';
import './globals.css';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { APP_NAME } from '@qa/shared';

import { QueryProvider } from '@/components/query-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: 'Quartz Scheduler 클러스터 관리 도구',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // next-themes가 hydration 전에 html의 class를 바꾸므로 경고를 끈다
    <html lang="ko" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <QueryProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </QueryProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
