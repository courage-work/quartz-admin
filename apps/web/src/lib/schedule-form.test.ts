import { describe, expect, it } from 'vitest';

import { parseSimpleSchedule, splitInterval, type SimpleScheduleInput } from './schedule-form';

const NOW = Date.UTC(2026, 10, 10, 3);
const base: SimpleScheduleInput = {
  interval: '5',
  unitMs: 1_000,
  repeatCount: '3',
  infinite: false,
  startMode: 'now',
  startAt: '',
};

describe('splitInterval', () => {
  it('나누어떨어지는 가장 큰 단위로 바꾼다', () => {
    expect(splitInterval(3_600_000)).toEqual({ value: 1, unitMs: 3_600_000 });
    expect(splitInterval(90_000)).toEqual({ value: 90, unitMs: 1_000 });
    expect(splitInterval(1_500)).toEqual({ value: 1_500, unitMs: 1 });
    expect(splitInterval(0)).toEqual({ value: 0, unitMs: 1_000 });
  });
});

describe('parseSimpleSchedule (TRD §7.6)', () => {
  it('간격을 ms로, 무한 반복은 -1로 바꾼다', () => {
    expect(parseSimpleSchedule(base, NOW)).toEqual({
      values: { repeatIntervalMs: 5_000, repeatCount: 3 },
      errors: null,
    });
    expect(parseSimpleSchedule({ ...base, infinite: true, repeatCount: '' }, NOW).values).toEqual({
      repeatIntervalMs: 5_000,
      repeatCount: -1,
    });
  });

  it('반복하는데 간격이 0이면 거부한다(S-04). 한 번만 실행하면 간격 0도 된다', () => {
    expect(parseSimpleSchedule({ ...base, interval: '0' }, NOW).errors).toEqual({
      interval: '반복하려면 간격이 0보다 커야 합니다',
    });
    expect(
      parseSimpleSchedule({ ...base, interval: '0', repeatCount: '0' }, NOW).errors,
    ).toBeNull();
  });

  it('정수가 아닌 값과 지난 시작 시각을 거부한다(S-03)', () => {
    const { errors } = parseSimpleSchedule(
      { ...base, interval: '1.5', repeatCount: '-2', startMode: 'at', startAt: '2020-01-01T00:00' },
      NOW,
    );
    expect(Object.keys(errors ?? {}).sort()).toEqual(['interval', 'repeatCount', 'startAt']);
  });

  it('지정한 시작 시각을 epoch ms로 바꾼다', () => {
    const later = new Date(NOW + 3_600_000);
    const local = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}T${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;
    expect(
      parseSimpleSchedule({ ...base, startMode: 'at', startAt: local }, NOW).values?.startAt,
    ).toBe(NOW + 3_600_000);
  });
});
