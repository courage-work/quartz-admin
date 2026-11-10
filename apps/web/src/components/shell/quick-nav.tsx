'use client';

import type { ConnectionDto, DashboardResponse } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarClockIcon,
  DatabaseIcon,
  FileIcon,
  type LucideIcon,
  SearchIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { EnvBadge } from '@/components/status/environment';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/auth';
import { CONNECTIONS_KEY } from '@/lib/connections';
import { type QuickNavItem, type QuickNavKind, quickNavGroups } from '@/lib/quick-nav';
import { DASHBOARD_KEY } from '@/lib/schedulers';

const KIND_ICONS: Record<QuickNavKind, LucideIcon> = {
  page: FileIcon,
  scheduler: CalendarClockIcon,
  connection: DatabaseIcon,
};

/**
 * 대화상자 안쪽. 열릴 때마다 새로 만들어져 검색어와 고른 줄이 처음으로 돌아간다.
 * 검색칸은 combobox, 목록은 listbox다. 포커스는 검색칸에 두고 위·아래 키로 줄을 고른다.
 */
function QuickNavPanel({ onGo }: { onGo: (href: string) => void }) {
  const user = useCurrentUser();
  const listId = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // 대시보드·접속 목록과 같은 조회를 쓴다(이미 읽어 둔 값이 있으면 바로 보인다)
  const schedulers = useQuery({
    queryKey: [...DASHBOARD_KEY, {}],
    queryFn: ({ signal }) => api<DashboardResponse>('/schedulers', { query: {}, signal }),
  });
  const connections = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: ({ signal }) => api<ConnectionDto[]>('/connections', { signal }),
  });

  const groups = quickNavGroups({
    q,
    isAdmin: user.isAdmin,
    schedulers: schedulers.data?.items ?? [],
    connections: connections.data ?? [],
  });
  const items: QuickNavItem[] = groups.flatMap((g) => g.items);
  // 목록이 줄어 고른 줄이 없어졌으면 마지막 줄로 맞춘다
  const current = Math.min(active, Math.max(0, items.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  // 키로 옮긴 줄이 목록 밖이면 보이는 곳으로 굴린다
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current, q]);

  const move = (delta: number) => {
    if (items.length === 0) return;
    setActive((current + delta + items.length) % items.length);
  };

  // 묶음마다 첫 줄이 전체 목록에서 몇 번째인지
  const offsets = groups.map((_, gi) =>
    groups.slice(0, gi).reduce((n, prev) => n + prev.items.length, 0),
  );
  return (
    <div className="flex flex-col gap-3">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          role="combobox"
          aria-label="화면, 스케줄러, 접속 이름으로 찾기"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={items.length > 0 ? optionId(current) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'Home' && items.length > 0) {
              e.preventDefault();
              setActive(0);
            } else if (e.key === 'End' && items.length > 0) {
              e.preventDefault();
              setActive(items.length - 1);
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              // 한글 조합 중의 Enter는 글자를 확정하는 것이다
              e.preventDefault();
              const item = items[current];
              if (item) onGo(item.href);
            }
          }}
        />
      </InputGroup>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="이동할 곳"
        className="-mx-2 flex max-h-80 flex-col gap-1 overflow-y-auto px-2"
      >
        {groups.map((g, gi) => {
          const Icon = KIND_ICONS[g.kind];
          return (
            <li key={g.kind} role="presentation">
              <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{g.title}</div>
              <ul role="group" aria-label={g.title} className="flex flex-col">
                {g.items.map((item, ii) => {
                  const i = (offsets[gi] ?? 0) + ii;
                  return (
                    <li
                      key={item.key}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === current}
                      onMouseMove={() => setActive(i)}
                      onClick={() => onGo(item.href)}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground pointer-coarse:py-3"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 truncate font-medium">{item.label}</span>
                      {item.envLabel ? <EnvBadge environment={item.envLabel} /> : null}
                      {item.hint ? (
                        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                          {item.hint}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
        {items.length === 0 ? (
          <li role="presentation" className="px-2 py-6 text-center text-sm text-muted-foreground">
            {schedulers.isPending || connections.isPending
              ? '목록을 읽는 중입니다'
              : '검색어에 맞는 화면, 스케줄러, 접속이 없습니다'}
          </li>
        ) : null}
      </ul>
      <p className="text-xs text-muted-foreground pointer-coarse:hidden">
        <Kbd>↑</Kbd> <Kbd>↓</Kbd> 고르기 · <Kbd>Enter</Kbd> 이동 · <Kbd>Esc</Kbd> 닫기
      </p>
    </div>
  );
}

/**
 * 빠른 이동 (헤더의 버튼, Ctrl+K·⌘K). 화면·스케줄러·접속을 이름으로 찾아 바로 간다.
 * 스케줄러가 많아지면 대시보드 → 카드 → 탭으로 가는 길이 길어지기 때문이다.
 */
export function QuickNav() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Radix Trigger로 열지 않으므로(단축키로도 연다) 닫은 뒤 포커스를 직접 돌려준다. 이동했으면 돌려주지 않는다
  const returnTo = useRef<HTMLElement | null>(null);
  const show = () => {
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) {
        return;
      }
      // 다른 대화상자(제어 확인 등)가 떠 있으면 그 위에 열지 않는다
      const other = document.querySelector(
        '[role="dialog"]:not([data-quick-nav]), [role="alertdialog"]',
      );
      if (other) return;
      e.preventDefault();
      if (document.querySelector('[data-quick-nav]')) setOpen(false);
      else show();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            aria-label="빠른 이동"
            aria-keyshortcuts="Control+K Meta+K"
            onClick={show}
          >
            <SearchIcon data-icon="inline-start" aria-hidden />
            {/* 좁은 화면에서는 아이콘만 남긴다 */}
            <span className="hidden text-muted-foreground md:inline">빠른 이동</span>
            <KbdGroup className="hidden md:inline-flex pointer-coarse:hidden">
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
          </Button>
        </TooltipTrigger>
        <TooltipContent>화면, 스케줄러, 접속으로 바로 가기</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          data-quick-nav
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnTo.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">빠른 이동</DialogTitle>
          <DialogDescription className="sr-only">
            화면, 스케줄러, 접속 이름을 입력해 고른 뒤 Enter로 이동합니다.
          </DialogDescription>
          <QuickNavPanel
            onGo={(href) => {
              returnTo.current = null;
              setOpen(false);
              router.push(href);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
