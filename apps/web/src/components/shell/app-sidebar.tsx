'use client';

import { APP_NAME } from '@qa/shared';
import {
  CalendarClockIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  ScrollTextIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { useCurrentUser } from '@/lib/auth';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** 이 경로들에서도 선택된 것으로 표시한다(상세 화면) */
  match?: string[];
}

const MAIN_NAV: NavItem[] = [
  { href: '/', label: '대시보드', icon: LayoutDashboardIcon },
  { href: '/audit-logs', label: '감사 로그', icon: ScrollTextIcon, match: ['/audit-log'] },
];

const ADMIN_NAV: NavItem[] = [{ href: '/users', label: '사용자', icon: UsersIcon }];

function isActive(pathname: string, item: NavItem): boolean {
  const path = pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  return path === item.href || (item.match ?? []).includes(path);
}

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild isActive={isActive(pathname, item)} tooltip={item.label}>
                <Link href={item.href}>
                  <item.icon aria-hidden />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** 왼쪽 내비게이션. 관리 메뉴는 관리자에게만 보인다(접근 통제는 API가 한다) */
export function AppSidebar() {
  const user = useCurrentUser();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link href="/">
                <CalendarClockIcon aria-hidden />
                <span className="font-semibold">{APP_NAME}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="운영" items={MAIN_NAV} />
        {user.isAdmin ? <NavGroup label="관리" items={ADMIN_NAV} /> : null}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
