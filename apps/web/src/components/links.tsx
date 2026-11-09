import { cn } from 'cn';
import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import type { ComponentProps } from 'react';

import { TableCell, TableHead, TableRow } from '@/components/ui/table';

/**
 * 이동 링크 (B-40, DESIGN §5). 밑줄 대신 두 가지로 눌러지는 곳을 보인다.
 *
 * - 줄 링크(`LinkRow` + `RowLink`): 목록 표에서 줄 하나가 상세 화면 하나일 때. 줄 전체가 눌리고,
 *   올리면 줄 바탕과 이름 색이 바뀌며 끝의 `›`가 움직인다. 이름은 굵게, 색은 본문과 같게 둔다.
 * - 글자 링크(`InlineLink`): 표 칸·문장 안에서 다른 화면을 가리킬 때(트리거 줄의 잡, 접속 이름).
 *   primary 색 글자로 보이고, 올리면 옅은 primary 바탕이 깔린다.
 */

/** 줄 링크 표의 줄. 안의 `RowLink`가 `::after`로 줄 전체를 덮는다 */
export function LinkRow(props: ComponentProps<typeof TableRow>) {
  return <TableRow className="group/row relative cursor-pointer" {...props} />;
}

/** 줄의 대표 칸(이름·시각)에 둔다. 한 줄에 하나만 */
export function RowLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      data-row-link
      className={cn(
        'font-medium text-foreground transition-colors group-hover/row:text-link',
        // 줄 전체를 덮는 누름 영역. 포커스 링도 줄 전체에 그린다
        'outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset',
        className,
      )}
      {...props}
    />
  );
}

/** 줄 링크 표의 마지막 머리 칸(빈 칸) */
export function RowChevronHead() {
  return <TableHead aria-hidden className="w-8" />;
}

/** 줄 링크 표의 마지막 칸. 줄이 눌린다는 것을 `›`로 보이고, 올리면 오른쪽으로 살짝 민다 */
export function RowChevronCell() {
  return (
    <TableCell aria-hidden className="w-8 text-right">
      <ChevronRightIcon className="inline size-4 text-muted-foreground transition duration-150 ease-out group-hover/row:translate-x-0.5 group-hover/row:text-foreground" />
    </TableCell>
  );
}

/** 표 칸·문장 안의 글자 링크 */
export function InlineLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        '-mx-1 rounded-sm px-1 font-medium text-link transition-colors outline-none hover:bg-link/10 focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}
