import { describe, expect, it } from 'vitest';

import {
  describeSchedule,
  formatAgo,
  formatInterval,
  isKnownTimeZone,
  misfireLabel,
  triggerTypeLabel,
} from './schedulers';

describe('formatInterval / formatAgo', () => {
  it('큰 단위 두 개까지 줄여 쓴다', () => {
    expect(formatInterval(5_400_000)).toBe('1시간 30분');
    expect(formatInterval(90_061_000)).toBe('1일 1시간');
    expect(formatInterval(7_500)).toBe('7초');
    expect(formatInterval(500)).toBe('500ms');
    expect(formatInterval(0)).toBe('0초');
  });

  it('지난 시간은 5초 미만이면 방금', () => {
    expect(formatAgo(1_000)).toBe('방금');
    expect(formatAgo(125_000)).toBe('2분 5초 전');
    expect(formatAgo(null)).toBe('-');
  });
});

describe('misfireLabel', () => {
  it('공통 값과 타입별 값을 구분한다', () => {
    expect(misfireLabel('CRON', 0)).toBe('스마트 정책(기본)');
    expect(misfireLabel('SIMPLE', -1)).toBe('무시하고 놓친 실행을 모두 함');
    expect(misfireLabel('CRON', 2)).toBe('건너뛰고 다음 일정');
    expect(misfireLabel('SIMPLE', 4)).toBe('다음 일정부터(남은 반복 횟수)');
    expect(misfireLabel('CRON', 9)).toBe('알 수 없음(9)');
    expect(misfireLabel('CRON', null)).toBe('-');
  });
});

describe('describeSchedule', () => {
  const base = { type: 'SIMPLE', cron: null, simple: null, simprop: null };
  it('타입별 일정을 한 줄로 쓴다', () => {
    expect(
      describeSchedule({
        ...base,
        type: 'CRON',
        cron: { expression: '0 0/5 * * * ?', timeZone: null },
      }),
    ).toBe('0 0/5 * * * ?');
    expect(
      describeSchedule({
        ...base,
        simple: { repeatCount: -1, repeatIntervalMs: 60_000, timesTriggered: 0 },
      }),
    ).toBe('1분마다, 무한 반복');
    expect(
      describeSchedule({
        ...base,
        simple: { repeatCount: 3, repeatIntervalMs: 10_000, timesTriggered: 0 },
      }),
    ).toBe('10초마다, 3회 더 반복');
    expect(
      describeSchedule({
        ...base,
        simple: { repeatCount: 0, repeatIntervalMs: 0, timesTriggered: 0 },
      }),
    ).toBe('한 번 실행');
    expect(
      describeSchedule({
        ...base,
        type: 'DAILY_I',
        simprop: { strings: [], ints: [], longs: [], decimals: [], bools: [] },
      }),
    ).toBe('하루 시간대 일정');
  });

  it('모르는 트리거 타입은 원래 값을 쓴다', () => {
    expect(triggerTypeLabel('CUSTOM')).toBe('CUSTOM');
  });
});

describe('isKnownTimeZone', () => {
  it('IANA ID는 알고, 엉뚱한 값은 모른다', () => {
    expect(isKnownTimeZone('Asia/Seoul')).toBe(true);
    expect(isKnownTimeZone('Not/AZone')).toBe(false);
  });
});
