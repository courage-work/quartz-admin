'use client';

import { type ReactNode, Suspense } from 'react';

import { AppSidebar } from '@/components/shell/app-sidebar';
import { AuthGate } from '@/components/shell/auth-gate';
import { UserMenu } from '@/components/shell/user-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ReturnNavTracker } from '@/lib/return-nav';

/** 로그인 후 화면의 공통 레이아웃: 사이드바, 헤더(테마, 본인 메뉴), 본문 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      {/* 화면마다 마지막 주소를 기억해 돌아가기 링크가 쓴다(B-40) */}
      <Suspense fallback={null}>
        <ReturnNavTracker />
      </Suspense>
      <SidebarProvider>
        <AppSidebar />
        {/* min-w-0: 넓은 표가 본문을 늘리지 않고 표 안에서 가로로 스크롤하게 한다 */}
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger />
              </TooltipTrigger>
              <TooltipContent>메뉴 펼치기·접기</TooltipContent>
            </Tooltip>
            <div className="flex-1" />
            <ThemeToggle />
            <UserMenu />
          </header>
          {/* 열이 많은 표가 있는 화면(`WidePage`)은 본문 폭을 넓힌다 */}
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 has-data-wide-page:max-w-384">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AuthGate>
  );
}
