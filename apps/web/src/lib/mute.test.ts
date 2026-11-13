import { describe, expect, it } from 'vitest';

import { formatMuteUntil, parseMuteUntil, toLocalInputValue } from './mute';

const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe('알림 음소거 (FR-ALT-10)', () => {
  it('끝나는 시각은 오늘이면 시:분, 다른 날이면 월-일까지 쓴다', () => {
    const now = at(2026, 11, 13, 9, 0);
    expect(formatMuteUntil(at(2026, 11, 13, 14, 30), now)).toBe('14:30');
    expect(formatMuteUntil(at(2026, 11, 14, 2, 5), now)).toBe('11-14 02:05');
  });

  it('직접 입력한 시각은 지금보다 뒤이고 7일 안이어야 한다', () => {
    const now = at(2026, 11, 13, 9, 0);
    expect(parseMuteUntil('', now)).toEqual({ error: '끝나는 시각을 입력하세요' });
    expect(parseMuteUntil(toLocalInputValue(now), now)).toEqual({
      error: '지금보다 뒤의 시각을 입력하세요',
    });
    expect(parseMuteUntil('2026-11-20T09:01', now)).toEqual({
      error: '음소거는 7일까지 할 수 있습니다',
    });
    expect(parseMuteUntil('2026-11-13T18:00', now)).toEqual({ until: at(2026, 11, 13, 18, 0) });
    expect(toLocalInputValue(at(2026, 1, 2, 3, 4))).toBe('2026-01-02T03:04');
  });
});
