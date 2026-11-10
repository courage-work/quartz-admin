import type { ConnectionDto, SchedulerSummaryDto } from '@qa/shared';

import { matchesQuery } from '@/lib/paging';

export type QuickNavKind = 'page' | 'scheduler' | 'connection';

export interface QuickNavItem {
  /** 목록 안에서 고유한 값 */
  key: string;
  kind: QuickNavKind;
  label: string;
  /** 이름 옆에 옅게 보이는 보조 글(접속 이름, 주소) */
  hint?: string;
  /** 스케줄러·접속의 환경 라벨. prod를 눈에 띄게 한다 */
  envLabel?: string;
  href: string;
}

export interface QuickNavGroup {
  kind: QuickNavKind;
  title: string;
  items: QuickNavItem[];
}

/** 묶음 하나에 보이는 최대 개수. 넘는 것은 검색어로 좁힌다 */
export const QUICK_NAV_GROUP_MAX = 8;

const PAGES: (QuickNavItem & { adminOnly?: boolean; words: string[] })[] = [
  { key: 'page:/', kind: 'page', label: '대시보드', href: '/', words: ['dashboard', '홈'] },
  {
    key: 'page:/connections',
    kind: 'page',
    label: '접속',
    href: '/connections',
    words: ['connection', 'db'],
  },
  {
    key: 'page:/connections/new',
    kind: 'page',
    label: '접속 추가하기',
    href: '/connections/new',
    words: ['connection', 'new', '등록'],
  },
  {
    key: 'page:/audit-logs',
    kind: 'page',
    label: '감사 로그',
    href: '/audit-logs',
    words: ['audit', 'log', '기록'],
  },
  {
    key: 'page:/users',
    kind: 'page',
    label: '사용자',
    href: '/users',
    adminOnly: true,
    words: ['user', '계정'],
  },
  {
    key: 'page:/account',
    kind: 'page',
    label: '비밀번호 변경',
    href: '/account',
    words: ['password', '계정'],
  },
];

/**
 * 빠른 이동 목록 (화면 → 스케줄러 → 접속). 검색어가 이름·보조 글·환경 중 하나에 들어 있는 것만 남기고,
 * 묶음마다 `QUICK_NAV_GROUP_MAX`개까지 보인다. 빈 묶음은 뺀다.
 */
export function quickNavGroups(input: {
  q: string;
  isAdmin: boolean;
  schedulers: readonly SchedulerSummaryDto[];
  connections: readonly ConnectionDto[];
}): QuickNavGroup[] {
  const { q } = input;
  const pages = PAGES.filter(
    (p) => (!p.adminOnly || input.isAdmin) && matchesQuery(q, [p.label, ...p.words]),
  ).map(({ adminOnly: _adminOnly, words: _words, ...item }) => item);

  const byName = (a: { label: string }, b: { label: string }) =>
    a.label.localeCompare(b.label, 'ko');

  const schedulers = input.schedulers
    .filter((s) =>
      matchesQuery(q, [s.displayName, s.schedName, s.connection.name, s.connection.envLabel]),
    )
    .map((s): QuickNavItem => ({
      key: `scheduler:${s.id}`,
      kind: 'scheduler',
      label: s.displayName,
      hint: s.connection.name,
      envLabel: s.connection.envLabel,
      href: `/scheduler?id=${s.id}`,
    }))
    .sort(byName);

  const connections = input.connections
    .filter((c) => matchesQuery(q, [c.name, c.host, c.envLabel, ...c.tags]))
    .map((c): QuickNavItem => ({
      key: `connection:${c.id}`,
      kind: 'connection',
      label: c.name,
      hint: c.host,
      envLabel: c.envLabel,
      href: `/connection?id=${c.id}`,
    }))
    .sort(byName);

  const groups: QuickNavGroup[] = [
    { kind: 'page', title: '화면', items: pages },
    { kind: 'scheduler', title: '스케줄러', items: schedulers },
    { kind: 'connection', title: '접속', items: connections },
  ];
  return groups
    .map((g) => ({ ...g, items: g.items.slice(0, QUICK_NAV_GROUP_MAX) }))
    .filter((g) => g.items.length > 0);
}
