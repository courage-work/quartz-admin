import type { ReactNode } from 'react';

import { FieldLabel, FieldTitle } from '@/components/ui/field';

/**
 * 화면 폼(추가·수정·설정)의 한 줄 (B-40). 왼쪽 1/4에 라벨, 오른쪽 3/4에 입력을 둔다.
 * 상세 화면 정보 카드(`dl`, `md:grid-cols-4`)와 같은 비율이라 상세 ↔ 수정을 오가도 자리가 같다.
 * 좁은 화면에서는 라벨이 입력 위로 온다.
 *
 * - `htmlFor`: 입력 하나에 붙는 라벨
 * - `labelId`: 라디오 묶음처럼 `aria-labelledby`로 이어 붙이는 라벨
 * - 둘 다 없으면 라벨 칸을 비운다(연결 테스트 버튼 같은 줄)
 */
export function FormRow({
  label,
  htmlFor,
  labelId,
  invalid,
  children,
}: {
  label?: string;
  htmlFor?: string;
  labelId?: string;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-4 md:gap-x-6">
      {/* 입력(36px) 글자와 라벨 글줄이 맞도록 넓은 화면에서 라벨을 8px 내린다 */}
      <div className={`md:pt-2 ${invalid ? 'text-destructive' : ''}`}>
        {label === undefined ? null : htmlFor ? (
          <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        ) : (
          <FieldTitle id={labelId}>{label}</FieldTitle>
        )}
      </div>
      <div className="min-w-0 md:col-span-3">{children}</div>
    </div>
  );
}

/** 폼 줄 묶음. 줄 사이 간격을 한곳에서 정한다 */
export function FormRows({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>;
}
