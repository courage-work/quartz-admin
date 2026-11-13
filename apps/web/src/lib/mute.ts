import { MUTE_MAX_MS } from '@qa/shared';

const MIN = 60_000;

/** 알림 음소거 기간 선택지 (FR-ALT-10). 점검 시간에 맞춰 짧은 것부터 둔다 */
export const MUTE_PRESETS = [
  { label: '30분', ms: 30 * MIN },
  { label: '1시간', ms: 60 * MIN },
  { label: '2시간', ms: 120 * MIN },
  { label: '4시간', ms: 240 * MIN },
] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** 음소거가 끝나는 시각. 오늘이면 시:분만, 다른 날이면 월-일 시:분 (브라우저 시간대) */
export function formatMuteUntil(until: number, now: number): string {
  const end = new Date(until);
  const today = new Date(now);
  const time = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  const sameDay =
    end.getFullYear() === today.getFullYear() &&
    end.getMonth() === today.getMonth() &&
    end.getDate() === today.getDate();
  return sameDay ? time : `${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${time}`;
}

/** `datetime-local` 입력 값(`YYYY-MM-DDTHH:mm`, 브라우저 시간대) */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** 직접 입력한 끝나는 시각을 검사한다. 지금보다 뒤이고 7일 안이어야 한다 (서버와 같은 규칙) */
export function parseMuteUntil(
  value: string,
  now: number,
): { until: number; error?: never } | { until?: never; error: string } {
  const until = value ? new Date(value).getTime() : Number.NaN;
  if (Number.isNaN(until)) return { error: '끝나는 시각을 입력하세요' };
  if (until <= now) return { error: '지금보다 뒤의 시각을 입력하세요' };
  if (until - now > MUTE_MAX_MS) return { error: '음소거는 7일까지 할 수 있습니다' };
  return { until };
}
