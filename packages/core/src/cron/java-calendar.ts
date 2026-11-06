/**
 * `java.util.GregorianCalendar`(lenient)의 필요한 동작만 흉내 낸다. `CronExpression.getTimeAfter`가 이 클래스의
 * 필드 설정과 정규화 규칙에 기대어 동작하기 때문이다.
 *
 * - `set`은 필드만 바꾸고, `get`이나 `getTime`을 부를 때 전체를 다시 계산한다(필드 넘침은 다음 단위로 넘어간다).
 * - 벽시계 시각 → 순간 변환은 JDK `ZoneInfo.getOffsetsByWall`과 같다. 전환 시각을 "새 오프셋으로 본 벽시계 시각"으로
 *   비교하므로, 없는 시각(DST 시작)은 앞으로 밀리고 겹치는 시각(DST 끝)은 표준시(뒤쪽 순간)가 된다.
 */
import type { JavaTimeZone } from '../tz/java-time-zone.js';

export const Field = {
  YEAR: 0,
  MONTH: 1,
  DAY_OF_MONTH: 2,
  HOUR_OF_DAY: 3,
  MINUTE: 4,
  SECOND: 5,
  MILLISECOND: 6,
  DAY_OF_WEEK: 7,
} as const;
export type Field = (typeof Field)[keyof typeof Field];

const DAY_MS = 86_400_000;

export class JavaCalendar {
  private year = 1970;
  /** 0~11 */
  private month = 0;
  private day = 1;
  private hour = 0;
  private minute = 0;
  private second = 0;
  private millis = 0;
  private time = 0;
  private dirty = false;

  constructor(private readonly zone: JavaTimeZone) {}

  setTime(epochMs: number): void {
    this.time = epochMs;
    this.computeFields();
    this.dirty = false;
  }

  getTime(): number {
    this.complete();
    return this.time;
  }

  get(field: Field): number {
    this.complete();
    switch (field) {
      case Field.YEAR:
        return this.year;
      case Field.MONTH:
        return this.month;
      case Field.DAY_OF_MONTH:
        return this.day;
      case Field.HOUR_OF_DAY:
        return this.hour;
      case Field.MINUTE:
        return this.minute;
      case Field.SECOND:
        return this.second;
      case Field.MILLISECOND:
        return this.millis;
      case Field.DAY_OF_WEEK:
        // Calendar.SUNDAY = 1 ... SATURDAY = 7
        return new Date(Date.UTC(this.year, this.month, this.day)).getUTCDay() + 1;
    }
  }

  set(field: Field, value: number): void {
    switch (field) {
      case Field.YEAR:
        this.year = value;
        break;
      case Field.MONTH:
        this.month = value;
        break;
      case Field.DAY_OF_MONTH:
        this.day = value;
        break;
      case Field.HOUR_OF_DAY:
        this.hour = value;
        break;
      case Field.MINUTE:
        this.minute = value;
        break;
      case Field.SECOND:
        this.second = value;
        break;
      case Field.MILLISECOND:
        this.millis = value;
        break;
      case Field.DAY_OF_WEEK:
        throw new Error('DAY_OF_WEEK는 설정하지 않는다');
    }
    this.dirty = true;
  }

  /** `add(Calendar.YEAR, n)`: 2월 29일은 해당 해의 말일로 맞춘다(pinDayOfMonth) */
  addYears(n: number): void {
    this.complete();
    this.year += n;
    const last = daysInMonth(this.year, this.month);
    if (this.day > last) this.day = last;
    this.dirty = true;
    this.complete();
  }

  private complete(): void {
    if (!this.dirty) return;
    const wall = wallMillis(
      this.year,
      this.month,
      this.day,
      this.hour,
      this.minute,
      this.second,
      this.millis,
    );
    this.time = wallToInstant(this.zone, wall);
    this.computeFields();
    this.dirty = false;
  }

  private computeFields(): void {
    const d = new Date(this.time + this.zone.offset(this.time));
    this.year = d.getUTCFullYear();
    this.month = d.getUTCMonth();
    this.day = d.getUTCDate();
    this.hour = d.getUTCHours();
    this.minute = d.getUTCMinutes();
    this.second = d.getUTCSeconds();
    this.millis = d.getUTCMilliseconds();
  }
}

/** 필드 넘침을 정규화한 벽시계 시각(UTC로 본 ms). 0~99년도 그대로 다룬다 */
function wallMillis(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
): number {
  const date = new Date(0);
  date.setUTCFullYear(y, mo, d);
  date.setUTCHours(h, mi, s, ms);
  return date.getTime();
}

/**
 * 벽시계 시각 → 순간. 앞뒤 하루의 오프셋이 같으면 그 오프셋을 쓴다. 다르면 그 사이 전환 시각을 찾아
 * "전환 시각 + 새 오프셋"보다 벽시계 시각이 같거나 늦으면 새 오프셋, 아니면 옛 오프셋을 쓴다.
 */
export function wallToInstant(zone: JavaTimeZone, wall: number): number {
  const before = zone.offset(wall - DAY_MS);
  const after = zone.offset(wall + DAY_MS);
  if (before === after) return wall - before;
  let lo = wall - DAY_MS;
  let hi = wall + DAY_MS;
  // 오프셋이 바뀌는 첫 순간을 1초 단위로 찾는다
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (zone.offset(mid) === before) lo = mid;
    else hi = mid;
  }
  const transition = hi;
  return wall >= transition + after ? wall - after : wall - before;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** month는 0~11 */
export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]!;
}
