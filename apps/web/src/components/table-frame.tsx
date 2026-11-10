import type { ReactNode } from 'react';

/**
 * 화면에 바로 놓이는 목록 표의 테두리(L1 표면). 카드 안의 표에는 쓰지 않는다(이중 테두리).
 * 표가 넓으면 이 안에서 가로로 스크롤한다. 머리 줄은 옅은 바탕으로 본문 줄과 구분한다.
 * 오른쪽에 고정한 머리 칸(`TableHead pinned`)에도 같은 바탕을 덧칠한다.
 */
export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs [&_th[data-pinned]]:before:bg-muted/60 [&_thead]:bg-muted/60">
      {children}
    </div>
  );
}
