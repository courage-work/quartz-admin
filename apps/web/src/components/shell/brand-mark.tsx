import { CalendarClockIcon } from 'lucide-react';

/** 제품 브랜드 마크(녹색 사각형 + 시계 달력). 사이드바와 로그인 화면이 같이 쓴다 */
export function BrandMark() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
      <CalendarClockIcon className="size-4" aria-hidden />
    </span>
  );
}
