import { formatDateTime } from '@/lib/format';
import { browserTimeZone, isKnownTimeZone } from '@/lib/schedulers';

/**
 * 시각 표시 (FR-VIEW-09). 사용자(브라우저) 타임존으로 보여 주고, 트리거 고유 타임존이 다르면
 * 그 타임존의 시각을 아래 줄에 함께 쓴다. Intl이 모르는 Java 타임존 ID는 이름만 쓴다.
 */
export function TimeCell({ ms, timeZone }: { ms: number | null; timeZone?: string | null }) {
  if (ms === null) return <span className="text-muted-foreground">-</span>;
  const other = timeZone && timeZone !== browserTimeZone() ? timeZone : null;
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{formatDateTime(ms)}</span>
      {other ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {isKnownTimeZone(other) ? `${formatDateTime(ms, other)} ${other}` : other}
        </span>
      ) : null}
    </span>
  );
}
