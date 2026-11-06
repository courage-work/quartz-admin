import { describe, expect, it } from 'vitest';

import { dateRange, formatDateTime, startOfLocalDay } from './format';

// vitest.config.ts에서 TZ=Asia/Seoul로 고정한다
const KST = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h - 9);

describe('formatDateTime', () => {
  it('사용자 타임존의 YYYY-MM-DD HH:mm:ss로 보여 준다', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 6, 5, 3, 22))).toBe('2026-11-06 14:03:22');
    expect(formatDateTime(Date.UTC(2026, 10, 6, 5, 3, 22), 'UTC')).toBe('2026-11-06 05:03:22');
  });

  it('값이 없으면 -', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime(undefined)).toBe('-');
  });
});

describe('startOfLocalDay, dateRange', () => {
  it('날짜 입력을 하루 시작 시각으로 바꾼다', () => {
    expect(startOfLocalDay('2026-11-06')).toBe(KST(2026, 11, 6));
  });

  it('형식이 틀리거나 없는 날짜는 무시한다', () => {
    expect(startOfLocalDay('')).toBeUndefined();
    expect(startOfLocalDay('2026-02-30')).toBeUndefined();
    expect(startOfLocalDay('2026/11/06')).toBeUndefined();
  });

  it('종료일을 포함하도록 to는 다음 날 0시다', () => {
    expect(dateRange('2026-11-01', '2026-11-06')).toEqual({
      from: KST(2026, 11, 1),
      to: KST(2026, 11, 7),
    });
    expect(dateRange('2026-12-31', '2026-12-31')).toEqual({
      from: KST(2026, 12, 31),
      to: KST(2027, 1, 1),
    });
  });

  it('한쪽만 입력하면 그쪽만 넘긴다', () => {
    expect(dateRange('', '2026-11-06')).toEqual({ to: KST(2026, 11, 7) });
    expect(dateRange('2026-11-06', '')).toEqual({ from: KST(2026, 11, 6) });
    expect(dateRange('', '')).toEqual({});
  });
});
