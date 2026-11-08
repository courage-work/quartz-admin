'use client';

import { APP_NAME } from '@qa/shared';
import {
  DatabaseIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  ScrollTextIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { BrandMark } from '@/components/shell/brand-mark';
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
  { href: '/', label: '대시보드', icon: LayoutDashboardIcon, match: ['/scheduler', '/job'] },
  {
    href: '/connections',
    label: '접속',
    icon: DatabaseIcon,
    match: ['/connection', '/connection/edit', '/connections/new', '/scheduler/settings'],
  },
  { href: '/audit-logs', label: '감사 로그', icon: ScrollTextIcon, match: ['/audit-log'] },
];

const ADMIN_NAV: NavItem[] = [
  { href: '/users', label: '사용자', icon: UsersIcon, match: ['/users/new'] },
];

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
            <SidebarMenuButton asChild size="lg" tooltip={APP_NAME}>
              <Link href="/">
                {/* 브랜드 마크: 접힌 사이드바(아이콘만)에서도 같은 자리에 남는다 */}
                <BrandMark />
                <span className="flex min-w-0 flex-col gap-0.5 leading-none">
                  <span className="truncate font-semibold">{APP_NAME}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Quartz 클러스터 관리
                  </span>
                </span>
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
