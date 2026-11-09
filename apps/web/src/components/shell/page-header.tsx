import type { ReactNode } from 'react';

import { BackButton, PageTrail, type TrailItem } from './back-nav';

export type { TrailItem } from './back-nav';

/**
 * 화면 맨 위 제목 줄. 오른쪽에 주요 동작 버튼을 둔다.
 * 상세·하위 화면은 `trail`에 상위 화면을 위에서부터 넘긴다. 제목 위에 경로가, 제목 왼쪽에
 * 마지막 상위 화면으로 가는 돌아가기 버튼이 붙는다(B-40).
 */
export function PageHeader({
  title,
  description,
  actions,
  trail,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  trail?: TrailItem[];
}) {
  const parent = trail?.at(-1);
  return (
    <div className="flex flex-col gap-2">
      {trail && trail.length > 0 ? <PageTrail items={trail} /> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-3">
            {parent ? <BackButton item={parent} /> : null}
            <h1 className="min-w-0 text-2xl leading-tight font-semibold wrap-break-word">
              {title}
            </h1>
          </div>
          {/* 넓은 화면에서는 설명을 제목 글자와 왼쪽을 맞춘다(돌아가기 버튼 폭 + 간격). 좁은 화면은 폭을 아낀다 */}
          {description ? (
            <div
              className={`text-sm text-muted-foreground ${parent ? 'md:pl-12 md:pointer-coarse:pl-14' : ''}`}
            >
              {description}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
