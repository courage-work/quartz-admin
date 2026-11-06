import type { ReactNode } from 'react';

/** cron 표현식, 트리거·잡 키, 잡 클래스 같은 코드성 텍스트 (D2Coding) */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-foreground">{children}</code>
  );
}
