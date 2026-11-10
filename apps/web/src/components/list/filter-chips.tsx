import { XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface FilterChip {
  key: string;
  /** 예: `상태: 대기` */
  label: string;
  onClear: () => void;
}

/**
 * 적용 중인 필터를 툴바 아래 칩으로 보여 주고 하나씩 지울 수 있게 한다 (DESIGN §8.1.3).
 * 필터 팝오버를 쓰는 목록(감사 로그, 트리거)이 함께 쓴다. 적용한 필터가 없으면 아무것도 그리지 않는다
 */
export function FilterChips({
  chips,
  onClearAll,
}: {
  chips: FilterChip[];
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div role="group" className="flex flex-wrap items-center gap-2" aria-label="적용 중인 필터">
      {chips.map((c) => (
        <Button
          key={c.key}
          variant="secondary"
          size="sm"
          onClick={c.onClear}
          aria-label={`${c.label} 필터 지우기`}
        >
          {c.label}
          <XIcon data-icon="inline-end" aria-hidden />
        </Button>
      ))}
      <Button variant="link" size="sm" onClick={onClearAll}>
        모두 지우기
      </Button>
    </div>
  );
}
