import type { TriggerDto, TriggerType } from '@qa/shared';

export const DASHBOARD_KEY = ['dashboard'] as const;
export const schedulerKey = (id: number) => ['schedulers', id] as const;
export const schedulerViewKey = (id: number, view: string, params?: unknown) =>
  ['schedulers', id, view, params ?? null] as const;

export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  CRON: 'Cron',
  SIMPLE: '단순 반복',
  CAL_INT: '달력 간격',
  DAILY_I: '하루 시간대',
  BLOB: '사용자 정의',
};

export function triggerTypeLabel(type: string): string {
  return (TRIGGER_TYPE_LABELS as Record<string, string>)[type] ?? type;
}

/**
 * misfire 처리 방식 라벨. 값의 의미가 트리거 타입마다 다르다
 * (Quartz `Trigger`, `CronTrigger`, `SimpleTrigger`, `CalendarIntervalTrigger`, `DailyTimeIntervalTrigger`).
 */
const MISFIRE_COMMON: Record<number, string> = {
  [-1]: '무시하고 놓친 실행을 모두 함',
  0: '스마트 정책(기본)',
};
const MISFIRE_BY_TYPE: Record<string, Record<number, string>> = {
  CRON: { 1: '지금 한 번 실행', 2: '건너뛰고 다음 일정' },
  CAL_INT: { 1: '지금 한 번 실행', 2: '건너뛰고 다음 일정' },
  DAILY_I: { 1: '지금 한 번 실행', 2: '건너뛰고 다음 일정' },
  SIMPLE: {
    1: '지금 실행',
    2: '지금 다시 시작(전체 반복 횟수)',
    3: '지금 다시 시작(남은 반복 횟수)',
    4: '다음 일정부터(남은 반복 횟수)',
    5: '다음 일정부터(전체 반복 횟수)',
  },
};

export function misfireLabel(type: string, value: number | null): string {
  if (value === null) return '-';
  return MISFIRE_COMMON[value] ?? MISFIRE_BY_TYPE[type]?.[value] ?? `알 수 없음(${value})`;
}

/** 밀리초 간격을 `1시간 30분`처럼 줄여 쓴다 */
export function formatInterval(ms: number): string {
  if (ms <= 0) return '0초';
  const units: [number, string][] = [
    [86_400_000, '일'],
    [3_600_000, '시간'],
    [60_000, '분'],
    [1_000, '초'],
  ];
  const parts: string[] = [];
  let rest = ms;
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  if (parts.length === 0) return `${ms}ms`;
  return parts.join(' ');
}

/** 지금까지 지난 시간. `3분 전`, `방금` */
export function formatAgo(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 5_000) return '방금';
  return `${formatInterval(ms)} 전`;
}

/** 트리거 일정 한 줄 요약 (FR-VIEW-04) */
export function describeSchedule(
  t: Pick<TriggerDto, 'type' | 'cron' | 'simple' | 'simprop'>,
): string {
  if (t.cron) return t.cron.expression;
  if (t.simple) {
    const { repeatCount, repeatIntervalMs } = t.simple;
    if (repeatCount === 0) return '한 번 실행';
    const times = repeatCount < 0 ? '무한 반복' : `${repeatCount}회 더 반복`;
    return `${formatInterval(repeatIntervalMs)}마다, ${times}`;
  }
  if (t.simprop) return `${triggerTypeLabel(t.type)} 일정`;
  return '-';
}

/** 브라우저(사용자) 타임존 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** Intl이 아는 타임존인지. Java의 3글자 ID(EST 등)는 모를 수 있다 */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 자동 새로고침 주기 (FR-VIEW-06). 0이면 끔 */
export const REFRESH_INTERVALS = [
  { value: 0, label: '자동 새로고침 끔' },
  { value: 10_000, label: '10초마다' },
  { value: 30_000, label: '30초마다' },
  { value: 60_000, label: '1분마다' },
] as const;
export const DEFAULT_REFRESH_MS = 30_000;
const REFRESH_STORAGE_KEY = 'qa.refreshMs';

export function loadRefreshMs(): number {
  try {
    const raw = window.localStorage.getItem(REFRESH_STORAGE_KEY);
    if (raw === null) return DEFAULT_REFRESH_MS;
    const ms = Number(raw);
    return REFRESH_INTERVALS.some((o) => o.value === ms) ? ms : DEFAULT_REFRESH_MS;
  } catch {
    return DEFAULT_REFRESH_MS;
  }
}

export function saveRefreshMs(ms: number): void {
  try {
    window.localStorage.setItem(REFRESH_STORAGE_KEY, String(ms));
  } catch {
    // 저장할 수 없는 환경(사생활 보호 모드 등)이면 이번 화면에서만 쓴다
  }
}
