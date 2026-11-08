import type { ReactNode } from 'react';

/**
 * 폼 아래 취소·저장 줄. 긴 폼에서도 화면 아래에 붙어 있게 한다 (VectorLab page-patterns: Form).
 * 주요 버튼을 오른쪽 끝에 두고, 좁은 화면에서는 줄바꿈한다.
 */
export function FormActions({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 border-t border-border bg-background py-3">
      {children}
    </div>
  );
}
