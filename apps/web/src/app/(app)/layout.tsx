'use client';

import { type ReactNode, Suspense, useState } from 'react';

import { AppSidebar } from '@/components/shell/app-sidebar';
import { AuthGate } from '@/components/shell/auth-gate';
import { QuickNav } from '@/components/shell/quick-nav';
import { TopTrailSlotContext } from '@/components/shell/top-trail';
import { UserMenu } from '@/components/shell/user-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ReturnNavTracker } from '@/lib/return-nav';

/** 로그인 후 화면의 공통 레이아웃: 사이드바, 헤더(테마, 본인 메뉴), 본문 */
export default function AppLayout({ children }: { children: ReactNode }) {
  // 화면(`PageHeader`)이 상단 바에 경로를 그릴 자리
  const [trailSlot, setTrailSlot] = useState<HTMLElement | null>(null);
  return (
    <AuthGate>
      {/* 화면마다 마지막 주소를 기억해 돌아가기 링크가 쓴다(B-40) */}
      <Suspense fallback={null}>
        <ReturnNavTracker />
      </Suspense>
      {/* 키보드로 들어오면 맨 먼저 닿는다. 사이드바와 헤더를 건너뛰고 본문으로 간다 (WCAG 2.4.1) */}
      <a
        href="#main-content"
        className="sr-only rounded-md bg-card px-3 py-2 text-sm font-medium shadow-md outline-none focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        본문으로 건너뛰기
      </a>
      <TopTrailSlotContext value={trailSlot}>
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
              <div ref={setTrailSlot} className="min-w-0 flex-1" />
              <QuickNav />
              <ThemeToggle />
              <UserMenu />
            </header>
            {/* 열이 많은 표가 있는 화면(`WidePage`)은 본문 폭을 넓힌다 */}
            <div
              id="main-content"
              tabIndex={-1}
              className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 outline-none has-data-wide-page:max-w-384"
            >
              {children}
            </div>
          </SidebarInset>
        </SidebarProvider>
      </TopTrailSlotContext>
    </AuthGate>
  );
}
