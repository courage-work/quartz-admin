'use client';

import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/shell/app-sidebar';
import { AuthGate } from '@/components/shell/auth-gate';
import { UserMenu } from '@/components/shell/user-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

/** 로그인 후 화면의 공통 레이아웃: 사이드바, 헤더(테마, 본인 메뉴), 본문 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-14 items-center gap-2 border-b border-border px-4">
            <SidebarTrigger />
            <div className="flex-1" />
            <ThemeToggle />
            <UserMenu />
          </header>
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </AuthGate>
  );
}
