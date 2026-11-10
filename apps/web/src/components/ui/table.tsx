'use client';

import * as React from 'react';
import { cn } from 'cn';

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="@container/table relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-sm', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'group/trow border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 오른쪽에 고정하는 칸(줄 끝 제어 메뉴). 표가 가로로 스크롤돼도 보이는 폭 안에 남는다.
 * 고정 칸은 불투명해야 하므로 면 색(bg-card)을 깔고, 줄 바탕(올림·머리 줄 색)은 `::before`로 덧칠한다.
 * 왼쪽 가는 선(`::after`)은 밑으로 다른 칸이 지나간다는 표시다.
 */
const PINNED =
  'sticky right-0 z-1 bg-card before:absolute before:inset-0 before:-z-1 before:transition-colors after:absolute after:inset-y-0 after:left-0 after:w-px after:bg-border';

function TableHead({
  className,
  pinned,
  ...props
}: React.ComponentProps<'th'> & { pinned?: boolean }) {
  return (
    <th
      data-slot="table-head"
      data-pinned={pinned ? '' : undefined}
      className={cn(
        'h-11 px-3 text-left align-middle font-medium whitespace-nowrap text-foreground first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0',
        pinned && PINNED,
        className,
      )}
      {...props}
    />
  );
}

function TableCell({
  className,
  pinned,
  ...props
}: React.ComponentProps<'td'> & { pinned?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      data-pinned={pinned ? '' : undefined}
      className={cn(
        'px-3 py-3 align-middle whitespace-nowrap first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0',
        // 줄에 올리거나 줄 안의 메뉴가 열리면 줄과 같은 바탕을 덧칠한다
        pinned &&
          `${PINNED} group-hover/trow:before:bg-muted/50 group-has-aria-expanded/trow:before:bg-muted/50`,
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
