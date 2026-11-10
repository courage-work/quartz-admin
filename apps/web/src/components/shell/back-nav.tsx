'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, type MouseEvent } from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isPreviousUrl, useReturnHref } from '@/lib/return-nav';

/** 상위 화면 하나. `href`는 기본 주소이고, 그 화면을 본 적이 있으면 마지막으로 본 주소로 간다 */
export interface TrailItem {
  label: string;
  href: string;
}

function plainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * 상위 화면으로 가는 링크. 바로 이전 화면이면 `router.back()`으로 가서 스크롤 위치까지 되살린다.
 * 새 탭으로 열기(가운데 클릭, Ctrl·Cmd 클릭)는 그대로 링크로 둔다.
 */
function useReturnLink(href: string) {
  const router = useRouter();
  const target = useReturnHref(href);
  const onClick = (e: MouseEvent) => {
    if (!plainClick(e) || !isPreviousUrl(target)) return;
    e.preventDefault();
    router.back();
  };
  return { href: target, onClick };
}

/** 제목 왼쪽의 돌아가기 버튼 */
export function BackButton({ item }: { item: TrailItem }) {
  const link = useReturnLink(item.href);
  const label = `돌아가기: ${item.label}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="icon" className="shrink-0">
          <Link {...link} aria-label={label} data-back-link>
            <ArrowLeftIcon aria-hidden />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function TrailLink({ item }: { item: TrailItem }) {
  const link = useReturnLink(item.href);
  return (
    <BreadcrumbLink asChild>
      <Link
        {...link}
        className="-mx-1 rounded-sm px-1 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {item.label}
      </Link>
    </BreadcrumbLink>
  );
}

/**
 * 경로. 상위 화면은 링크이고, `current`를 주면 지금 화면을 마지막에 글자로 붙인다.
 * 좁은 화면에서는 제목 위에 상위 화면만, 넓은 화면에서는 상단 바에 지금 화면까지 그린다(`PageHeader`).
 */
export function PageTrail({ items, current }: { items: TrailItem[]; current?: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {items.map((item, i) => (
          <Fragment key={`${i}-${item.href}`}>
            {i > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              <TrailLink item={item} />
            </BreadcrumbItem>
          </Fragment>
        ))}
        {current === undefined ? null : (
          <>
            {items.length > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              <BreadcrumbPage>
                {/* 이름이 길면 상단 바의 다른 버튼을 밀어내지 않게 자른다 */}
                <span className="block max-w-64 truncate" title={current}>
                  {current}
                </span>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
