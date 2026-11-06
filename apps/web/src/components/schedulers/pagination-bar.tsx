'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** 서버 페이지네이션 목록의 이전·다음 이동 (NFR-PERF-02) */
export function PaginationBar({
  page,
  size,
  total,
  onPageChange,
}: {
  page: number;
  size: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground tabular-nums">
        {total.toLocaleString()}개 중 {from.toLocaleString()}–{to.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeftIcon data-icon="inline-start" aria-hidden />
          이전 페이지
        </Button>
        <span className="text-sm tabular-nums">
          {page} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          다음 페이지
          <ChevronRightIcon data-icon="inline-end" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
