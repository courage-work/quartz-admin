import { TONE_CLASSES, TRIGGER_STATE_META } from '@/components/status/tones';

/** 막대에 그리는 순서. 정상 흐름(대기→실행) 다음에 손볼 상태를 둔다 */
const ORDER = [
  'WAITING',
  'ACQUIRED',
  'EXECUTING',
  'COMPLETE',
  'PAUSED',
  'BLOCKED',
  'PAUSED_BLOCKED',
  'ERROR',
] as const;

/**
 * 트리거 상태 분포 막대. 너비를 인라인 스타일 없이 그리려고 SVG 좌표를 쓴다.
 * 색만으로 전하지 않도록 aria-label에 상태별 수를 넣고, 화면에는 배지 범례를 함께 둔다.
 */
export function TriggerDistribution({ counts }: { counts: Record<string, number> }) {
  const segments = ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => ({
    state: s,
    count: counts[s]!,
    meta: TRIGGER_STATE_META[s],
  }));
  const total = segments.reduce((a, s) => a + s.count, 0);
  if (total === 0) return null;
  const label = segments.map((s) => `${s.meta.label} ${s.count}`).join(', ');
  // 앞 조각들의 누적 너비가 다음 조각의 x다
  const rects = segments.map((s, i) => ({
    ...s,
    x: (segments.slice(0, i).reduce((a, p) => a + p.count, 0) / total) * 100,
    width: (s.count / total) * 100,
  }));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <svg
        viewBox="0 0 100 1"
        preserveAspectRatio="none"
        className="block size-full"
        role="img"
        aria-label={`트리거 상태 분포: ${label}`}
      >
        {rects.map((s) => (
          <rect
            key={s.state}
            x={s.x}
            y={0}
            width={s.width}
            height={1}
            className={TONE_CLASSES[s.meta.tone].fill}
          />
        ))}
      </svg>
    </div>
  );
}
