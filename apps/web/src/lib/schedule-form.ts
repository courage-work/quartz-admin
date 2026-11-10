import { REPEAT_COUNT_MAX, REPEAT_INTERVAL_MAX } from '@qa/shared';

/** SIMPLE 간격 입력 단위. 저장은 ms다 */
export const INTERVAL_UNITS = [
  { ms: 1, label: '밀리초' },
  { ms: 1_000, label: '초' },
  { ms: 60_000, label: '분' },
  { ms: 3_600_000, label: '시간' },
  { ms: 86_400_000, label: '일' },
] as const;

/** ms 간격을 나누어떨어지는 가장 큰 단위로 바꾼다. 0이면 초 */
export function splitInterval(ms: number): { value: number; unitMs: number } {
  if (ms <= 0) return { value: 0, unitMs: 1_000 };
  for (const unit of [...INTERVAL_UNITS].reverse()) {
    if (ms % unit.ms === 0) return { value: ms / unit.ms, unitMs: unit.ms };
  }
  return { value: ms, unitMs: 1 };
}

export interface SimpleScheduleInput {
  interval: string;
  unitMs: number;
  repeatCount: string;
  infinite: boolean;
  startMode: 'now' | 'at';
  /** `datetime-local` 값(브라우저 타임존) */
  startAt: string;
}

export type SimpleScheduleErrors = Partial<Record<'interval' | 'repeatCount' | 'startAt', string>>;

export interface SimpleScheduleValues {
  repeatIntervalMs: number;
  repeatCount: number;
  startAt?: number;
}

const INTEGER = /^\d+$/;

/**
 * SIMPLE 스케줄 입력 검사 (TRD §7.6, `SimpleTriggerImpl.validate`). 서버도 같은 기준으로 다시 거부한다.
 * 통과하면 명령 값을, 아니면 칸별 오류를 돌려준다.
 */
export function parseSimpleSchedule(
  input: SimpleScheduleInput,
  now: number,
): { values: SimpleScheduleValues; errors: null } | { values: null; errors: SimpleScheduleErrors } {
  const errors: SimpleScheduleErrors = {};
  const interval = input.interval.trim();
  const count = input.repeatCount.trim();
  const repeatCount = input.infinite ? -1 : Number(count);
  const repeatIntervalMs = Number(interval) * input.unitMs;

  if (!input.infinite) {
    if (!INTEGER.test(count)) errors.repeatCount = '반복 횟수는 0 이상의 정수로 입력하세요';
    else if (repeatCount > REPEAT_COUNT_MAX) {
      errors.repeatCount = `반복 횟수는 ${REPEAT_COUNT_MAX.toLocaleString()}번까지입니다`;
    }
  }
  if (!INTEGER.test(interval)) errors.interval = '간격은 0 이상의 정수로 입력하세요';
  else if (repeatIntervalMs > REPEAT_INTERVAL_MAX) errors.interval = '간격이 너무 깁니다';
  else if (repeatCount !== 0 && repeatIntervalMs < 1) {
    errors.interval = '반복하려면 간격이 0보다 커야 합니다';
  }

  let startAt: number | undefined;
  if (input.startMode === 'at') {
    const t = input.startAt ? new Date(input.startAt).getTime() : Number.NaN;
    if (Number.isNaN(t)) errors.startAt = '시작 시각을 고르세요';
    else if (t <= now) errors.startAt = '시작 시각은 지금 이후여야 합니다';
    else startAt = t;
  }

  if (Object.keys(errors).length > 0) return { values: null, errors };
  return {
    values: { repeatIntervalMs, repeatCount, ...(startAt !== undefined ? { startAt } : {}) },
    errors: null,
  };
}

/** epoch ms → `datetime-local` 값(브라우저 타임존, 분 단위) */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
