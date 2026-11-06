import { describe, expect, it } from 'vitest';
import { cronSchedule } from './schedule.js';
import { validateCron } from './validate.js';

function error(expr: string) {
  const r = validateCron(expr);
  if (r.ok) throw new Error(`거부되어야 함: ${expr}`);
  return r.error;
}

describe('validateCron', () => {
  it('표현식을 대문자로 맞추고 공백을 정리한다', () => {
    const r = validateCron('  0 0 12 ?  * mon-fri ');
    expect(r.ok && r.expression).toBe('0 0 12 ? * MON-FRI');
  });

  it('필드 수가 맞지 않으면 개수를 알려 준다', () => {
    expect(error('0 0 12 * *').code).toBe('SYNTAX');
    expect(error('0 0 12 * *').message).toContain('지금은 5개');
    expect(error('0 0 0 * * ? 2026 2027')).toMatchObject({ code: 'SYNTAX' });
    expect(error('   ')).toMatchObject({ message: 'cron 표현식을 입력하세요' });
  });

  it('범위를 벗어난 값은 필드 이름과 함께 알려 준다', () => {
    expect(error('0 0 25 * * ?')).toEqual({
      code: 'RANGE',
      field: '시',
      message: '시 값은 0~23 사이여야 합니다: 25',
    });
    expect(error('0 60 * * * ?')).toMatchObject({ code: 'RANGE', field: '분' });
    expect(error('0 0 0 32 * ?')).toMatchObject({ code: 'RANGE', field: '일' });
    expect(error('0 0 0 ? * 8')).toMatchObject({ code: 'RANGE', field: '요일' });
    expect(error('0 0 0 1 1 ? 1969')).toMatchObject({ code: 'RANGE', field: '연도' });
    expect(error('0/0 * * * * ?')).toMatchObject({ code: 'RANGE', field: '초' });
    expect(error('0 0 0/24 * * ?')).toMatchObject({ code: 'RANGE', field: '시' });
  });

  it("일과 요일 중 하나만 '?'여야 한다", () => {
    expect(error('0 0 0 * * *').code).toBe('SYNTAX');
    expect(error('0 0 0 * * *').message).toContain("'?'");
    expect(error('0 0 0 ? * ?')).toMatchObject({ code: 'SYNTAX' });
  });

  it('이름은 월과 요일에만 쓰고, 이름에는 증가값을 붙일 수 없다', () => {
    expect(validateCron('0 0 0 1 JAN-MAR,OCT ?').ok).toBe(true);
    expect(error('0 0 0 ? FOO *').field).toBe('월');
    expect(error('0 0 0 ? FOO *').message).toContain('JAN');
    expect(error('0 0 0 1 JAN-MAR/2 ?')).toMatchObject({ field: '월' });
    expect(error('MON 0 0 * * ?')).toMatchObject({ field: '초' });
  });

  it('L, W, #는 정해진 형태로만 쓴다', () => {
    for (const ok of [
      '0 0 0 L * ?',
      '0 0 0 L-3 * ?',
      '0 0 0 LW * ?',
      '0 0 0 L-2W * ?',
      '0 0 0 15W * ?',
      '0 0 0 28W * ?',
      '0 0 0 ? * L',
      '0 0 0 ? * 6L',
      '0 0 0 ? * FRIL',
      '0 0 0 ? * 6#3',
      '0 0 0 ? * MON#1',
    ]) {
      expect(validateCron(ok).ok, ok).toBe(true);
    }
    expect(error('0 0 0 L,15 * ?')).toMatchObject({ field: '일' });
    expect(error('0 0 0 L-31 * ?')).toMatchObject({ code: 'RANGE', field: '일' });
    expect(error('0 0 0 ? * 1#6')).toMatchObject({ code: 'RANGE', field: '요일' });
    expect(error('0 0 0 ? * 1#2,2#3')).toMatchObject({ field: '요일' });
    expect(error('0 L * * * ?')).toMatchObject({ field: '분' });
  });

  it('Quartz 버전마다 결과가 다른 형태는 지원하지 않는다고 알려 준다', () => {
    expect(error('0 0 0 31W * ?')).toMatchObject({ code: 'UNSUPPORTED', field: '일' });
    expect(error('0 0 0 29W * ?')).toMatchObject({ code: 'UNSUPPORTED' });
    expect(error('0 0 0 1W,15 * ?')).toMatchObject({ code: 'UNSUPPORTED', field: '일' });
  });
});

describe('cronSchedule', () => {
  const at = (iso: string) => Date.parse(iso);
  const iso = (ms: number) => new Date(ms).toISOString();

  it('Asia/Seoul 평일 9시 30분', () => {
    const s = cronSchedule('0 30 9 ? * MON-FRI', 'Asia/Seoul');
    // 2026-11-06(금) 00:00 KST 이후
    expect(s.nextTimes(at('2026-11-05T15:00:00Z'), 3).map(iso)).toEqual([
      '2026-11-06T00:30:00.000Z',
      '2026-11-09T00:30:00.000Z',
      '2026-11-10T00:30:00.000Z',
    ]);
  });

  it('DST가 시작되는 날 없는 시각은 건너뛴다(Quartz와 같음)', () => {
    const s = cronSchedule('0 30 2 * * ?', 'America/New_York');
    expect(s.nextTimes(at('2026-03-07T12:00:00Z'), 2).map(iso)).toEqual([
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('DST가 끝나는 날 겹치는 시각은 한 번만 발화한다', () => {
    const s = cronSchedule('0 30 1 * * ?', 'America/New_York');
    const times = s.nextTimes(at('2026-10-31T12:00:00Z'), 2).map(iso);
    expect(times).toHaveLength(2);
    expect(times[0]!.startsWith('2026-11-01')).toBe(true);
    expect(times[1]!.startsWith('2026-11-02')).toBe(true);
  });

  it('끝이 있는 표현식은 가능한 만큼만 돌려준다', () => {
    expect(
      cronSchedule('0 0 0 1 1 ? 2030', 'UTC').nextTimes(at('2026-01-01T00:00:00Z'), 5),
    ).toEqual([at('2030-01-01T00:00:00Z')]);
    expect(cronSchedule('0 0 0 * * ? 2025', 'UTC').next(at('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('모르는 타임존 ID는 Java처럼 GMT로 계산하고 그 사실을 알려 준다', () => {
    const s = cronSchedule('0 0 9 * * ?', 'KST');
    expect(s.timeZone).toMatchObject({ javaId: 'GMT', fallbackToGmt: true });
    expect(iso(s.next(at('2026-01-01T00:00:00Z'))!)).toBe('2026-01-01T09:00:00.000Z');
  });
});
