import type { ReactNode } from 'react';

/**
 * 화면에 바로 놓이는 목록 표의 테두리(L1 표면). 카드 안의 표에는 쓰지 않는다(이중 테두리).
 * 표가 넓으면 이 안에서 가로로 스크롤한다.
 */
export function TableFrame({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border bg-card">{children}</div>;
}
