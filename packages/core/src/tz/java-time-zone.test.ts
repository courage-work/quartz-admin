import { describe, expect, it } from 'vitest';
import { wallToInstant } from '../cron/java-calendar.js';
import { resolveJavaTimeZone } from './java-time-zone.js';

const H = 3_600_000;

describe('resolveJavaTimeZone', () => {
  it('JDK 규칙대로 축약 ID와 사용자 지정 오프셋을 해석한다', () => {
    expect(resolveJavaTimeZone('EST').offset(Date.UTC(2026, 6, 1))).toBe(-5 * H);
    expect(resolveJavaTimeZone('PST').offset(Date.UTC(2026, 6, 1))).toBe(-7 * H);
    expect(resolveJavaTimeZone('GMT+9')).toMatchObject({
      javaId: 'GMT+09:00',
      fallbackToGmt: false,
    });
    expect(resolveJavaTimeZone('GMT-0530').offset(0)).toBe(-5.5 * H);
  });

  it('모르는 ID, 대소문자가 다른 ID, 범위를 벗어난 오프셋은 GMT다', () => {
    for (const id of ['KST', 'asia/seoul', 'Asia/Seoul ', 'UTC+9', 'GMT+24', '']) {
      expect(resolveJavaTimeZone(id), JSON.stringify(id)).toMatchObject({
        javaId: 'GMT',
        fallbackToGmt: true,
      });
    }
  });
});

describe('wallToInstant (GregorianCalendar 벽시계 → 순간)', () => {
  const ny = resolveJavaTimeZone('America/New_York');

  it('DST 시작일의 없는 시각은 한 시간 뒤로 밀린다', () => {
    // 2026-03-08 02:30(없음) → 03:30 EDT = 07:30Z
    expect(wallToInstant(ny, Date.UTC(2026, 2, 8, 2, 30))).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  it('DST 종료일의 겹치는 시각은 표준시(뒤쪽 순간)로 본다', () => {
    // 2026-11-01 01:30은 EDT(05:30Z)와 EST(06:30Z) 두 번 있다. Java Calendar는 EST를 고른다
    expect(wallToInstant(ny, Date.UTC(2026, 10, 1, 1, 30))).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it('전환이 없는 날은 오프셋만 뺀다', () => {
    expect(wallToInstant(resolveJavaTimeZone('Asia/Seoul'), Date.UTC(2026, 0, 1, 9))).toBe(
      Date.UTC(2026, 0, 1, 0),
    );
  });
});
