'use client';

import { APP_NAME } from '@qa/shared';
import {
  BellIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  ScrollTextIcon,
  SendIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

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
  {
    href: '/',
    label: '대시보드',
    icon: LayoutDashboardIcon,
    match: ['/scheduler', '/scheduler/alert-rule', '/job'],
  },
  {
    href: '/connections',
    label: '접속',
    icon: DatabaseIcon,
    match: ['/connection', '/connection/edit', '/connections/new', '/scheduler/settings'],
  },
  { href: '/alerts', label: '알림 센터', icon: BellIcon },
  {
    href: '/channels',
    label: '알림 채널',
    icon: SendIcon,
    match: ['/channels/new', '/channel/edit'],
  },
  { href: '/audit-logs', label: '감사 로그', icon: ScrollTextIcon, match: ['/audit-log'] },
];

const ADMIN_NAV: NavItem[] = [
  { href: '/users', label: '사용자', icon: UsersIcon, match: ['/users/new'] },
];

function isActive(pathname: string, from: string | null, item: NavItem): boolean {
  const path = pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  // 스케줄러 상세에서 들어온 설정 화면(`from=scheduler`)은 경로처럼 대시보드 아래로 본다
  if (path === '/scheduler/settings' && from === 'scheduler') return item.href === '/';
  return path === item.href || (item.match ?? []).includes(path);
}

function NavGroup({
  label,
  items,
  from,
}: {
  label: string;
  items: NavItem[];
  from: string | null;
}) {
  const pathname = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                asChild
                isActive={isActive(pathname, from, item)}
                tooltip={item.label}
              >
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

function NavGroups({ from }: { from: string | null }) {
  const user = useCurrentUser();
  return (
    <>
      <NavGroup label="운영" items={MAIN_NAV} from={from} />
      {user.isAdmin ? <NavGroup label="관리" items={ADMIN_NAV} from={from} /> : null}
    </>
  );
}

/** 주소의 `from`을 읽는다. 정적 export에서 `useSearchParams`를 쓰려면 Suspense 경계가 필요하다 */
function NavGroupsFromUrl() {
  return <NavGroups from={useSearchParams().get('from')} />;
}

/** 왼쪽 내비게이션. 관리 메뉴는 관리자에게만 보인다(접근 통제는 API가 한다) */
export function AppSidebar() {
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
        <Suspense fallback={<NavGroups from={null} />}>
          <NavGroupsFromUrl />
        </Suspense>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
