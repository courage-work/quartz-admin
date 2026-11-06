/*
 * All content copyright Terracotta, Inc., unless otherwise indicated. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Modifications copyright (c) 2026 courage-work: ported from
 * org.quartz.CronExpression (Quartz Scheduler 2.3.2) to TypeScript for quartz-admin.
 * The parsing and next-fire-time algorithm is kept line by line so that results match
 * the Java implementation; java.util.Calendar is emulated by ./java-calendar.ts.
 */
import type { JavaTimeZone } from '../tz/java-time-zone.js';
import { daysInMonth, Field, JavaCalendar } from './java-calendar.js';

const SECOND = 0;
const MINUTE = 1;
const HOUR = 2;
const DAY_OF_MONTH = 3;
const MONTH = 4;
const DAY_OF_WEEK = 5;
const YEAR = 6;
const ALL_SPEC_INT = 99;
const NO_SPEC_INT = 98;

const MONTH_MAP: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

const DAY_MAP: Record<string, number> = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };

const SUNDAY = 1;
const SATURDAY = 7;

/** `CronExpression.MAX_YEAR`: 클래스를 읽은 해 + 100 */
export const MAX_YEAR = new Date().getFullYear() + 100;

/** `java.text.ParseException`. Quartz가 표현식을 거부할 때의 메시지를 그대로 담는다 */
export class QuartzParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'QuartzParseError';
  }
}

/** 파싱 중 Java 런타임 예외(StringIndexOutOfBounds 등). buildExpression이 ParseException으로 감싼다 */
class JavaRuntimeError extends Error {}

/** `TreeSet<Integer>` 대용. 원소가 적어 정렬 배열로 둔다 */
class IntSet {
  private readonly values: number[] = [];

  add(v: number): void {
    let lo = 0;
    let hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.values[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (this.values[lo] !== v) this.values.splice(lo, 0, v);
  }

  has(v: number): boolean {
    return this.ceiling(v) === v;
  }

  isEmpty(): boolean {
    return this.values.length === 0;
  }

  first(): number {
    if (this.values.length === 0) throw new JavaRuntimeError('NoSuchElementException');
    return this.values[0]!;
  }

  last(): number {
    if (this.values.length === 0) throw new JavaRuntimeError('NoSuchElementException');
    return this.values[this.values.length - 1]!;
  }

  /** `tailSet(v).first()` 또는 없으면 undefined */
  ceiling(v: number): number | undefined {
    let lo = 0;
    let hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.values[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return this.values[lo];
  }

  toArray(): readonly number[] {
    return this.values;
  }
}

function charAt(s: string, i: number): string {
  if (i < 0 || i >= s.length) throw new JavaRuntimeError(`StringIndexOutOfBoundsException: ${i}`);
  return s[i]!;
}

function substring(s: string, start: number, end: number = s.length): string {
  if (start < 0 || end > s.length || start > end) {
    throw new JavaRuntimeError(`StringIndexOutOfBoundsException: begin ${start}, end ${end}`);
  }
  return s.slice(start, end);
}

/** `Integer.parseInt`: 부호 하나와 숫자만, int 범위 */
function parseInt32(s: string): number {
  if (!/^[+-]?\d+$/.test(s)) throw new JavaRuntimeError(`NumberFormatException: ${s}`);
  const v = Number(s);
  if (v > 2147483647 || v < -2147483648) throw new JavaRuntimeError(`NumberFormatException: ${s}`);
  return v;
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** Java `String.trim()`: 앞뒤의 U+0020 이하 문자를 지운다 */
function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 32) start++;
  while (end > start && s.charCodeAt(end - 1) <= 32) end--;
  return s.slice(start, end);
}

interface ValueSet {
  value: number;
  pos: number;
}

/**
 * Quartz 2.3.2 `org.quartz.CronExpression` 이식본. 직접 쓰지 말고 `validateCron`, `parseCron`을 쓴다
 * (2.5.x와 결과가 다른 표현식을 거르는 검증이 그쪽에 있다).
 */
export class QuartzCronExpression {
  readonly expression: string;
  readonly seconds = new IntSet();
  readonly minutes = new IntSet();
  readonly hours = new IntSet();
  readonly daysOfMonth = new IntSet();
  readonly months = new IntSet();
  readonly daysOfWeek = new IntSet();
  readonly years = new IntSet();
  lastdayOfWeek = false;
  nthdayOfWeek = 0;
  lastdayOfMonth = false;
  nearestWeekday = false;
  lastdayOffset = 0;
  /** 공백으로 나눈 필드 수. 7개를 넘으면 2.3.2는 나머지를 무시하고 2.5.x는 거부한다 */
  termCount = 0;

  /** @throws QuartzParseError */
  constructor(cronExpression: string) {
    this.expression = cronExpression.toUpperCase();
    this.buildExpression(this.expression);
  }

  private buildExpression(expression: string): void {
    try {
      let exprOn = SECOND;
      const tokens = expression.split(/[ \t]+/).filter((t) => t.length > 0);
      this.termCount = tokens.length;
      for (const raw of tokens) {
        if (exprOn > YEAR) break;
        const expr = javaTrim(raw);
        if (
          exprOn === DAY_OF_MONTH &&
          expr.includes('L') &&
          expr.length > 1 &&
          expr.includes(',')
        ) {
          throw new QuartzParseError(
            "Support for specifying 'L' and 'LW' with other days of the month is not implemented",
            -1,
          );
        }
        if (exprOn === DAY_OF_WEEK && expr.includes('L') && expr.length > 1 && expr.includes(',')) {
          throw new QuartzParseError(
            "Support for specifying 'L' with other days of the week is not implemented",
            -1,
          );
        }
        if (
          exprOn === DAY_OF_WEEK &&
          expr.includes('#') &&
          expr.indexOf('#', expr.indexOf('#') + 1) !== -1
        ) {
          throw new QuartzParseError(
            'Support for specifying multiple "nth" days is not implemented.',
            -1,
          );
        }
        for (const v of expr.split(',').filter((t) => t.length > 0)) {
          this.storeExpressionVals(0, v, exprOn);
        }
        exprOn++;
      }
      if (exprOn <= DAY_OF_WEEK) {
        throw new QuartzParseError('Unexpected end of expression.', expression.length);
      }
      if (exprOn <= YEAR) {
        this.storeExpressionVals(0, '*', YEAR);
      }
      const dayOfMSpec = !this.daysOfMonth.has(NO_SPEC_INT);
      const dayOfWSpec = !this.daysOfWeek.has(NO_SPEC_INT);
      if (!dayOfMSpec || dayOfWSpec) {
        if (!dayOfWSpec || dayOfMSpec) {
          throw new QuartzParseError(
            'Support for specifying both a day-of-week AND a day-of-month parameter is not implemented.',
            0,
          );
        }
      }
    } catch (e) {
      if (e instanceof QuartzParseError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new QuartzParseError(`Illegal cron expression format (${msg})`, 0);
    }
  }

  private storeExpressionVals(pos: number, s: string, type: number): number {
    let incr = 0;
    let i = this.skipWhiteSpace(pos, s);
    if (i >= s.length) return i;
    let c = charAt(s, i);
    if (c >= 'A' && c <= 'Z' && s !== 'L' && s !== 'LW' && !/^L-[0-9]*[W]?$/.test(s)) {
      let sub = substring(s, i, i + 3);
      let sval: number;
      let eval_ = -1;
      if (type === MONTH) {
        sval = this.getMonthNumber(sub) + 1;
        if (sval <= 0) throw new QuartzParseError(`Invalid Month value: '${sub}'`, i);
        if (s.length > i + 3) {
          c = charAt(s, i + 3);
          if (c === '-') {
            i += 4;
            sub = substring(s, i, i + 3);
            eval_ = this.getMonthNumber(sub) + 1;
            if (eval_ <= 0) throw new QuartzParseError(`Invalid Month value: '${sub}'`, i);
          }
        }
      } else if (type === DAY_OF_WEEK) {
        sval = this.getDayOfWeekNumber(sub);
        if (sval < 0) throw new QuartzParseError(`Invalid Day-of-Week value: '${sub}'`, i);
        if (s.length > i + 3) {
          c = charAt(s, i + 3);
          if (c === '-') {
            i += 4;
            sub = substring(s, i, i + 3);
            eval_ = this.getDayOfWeekNumber(sub);
            if (eval_ < 0) throw new QuartzParseError(`Invalid Day-of-Week value: '${sub}'`, i);
          } else if (c === '#') {
            try {
              i += 4;
              this.nthdayOfWeek = parseInt32(substring(s, i));
              if (this.nthdayOfWeek < 1 || this.nthdayOfWeek > 5) throw new Error();
            } catch {
              throw new QuartzParseError(
                "A numeric value between 1 and 5 must follow the '#' option",
                i,
              );
            }
          } else if (c === 'L') {
            this.lastdayOfWeek = true;
            i++;
          }
        }
      } else {
        throw new QuartzParseError(`Illegal characters for this position: '${sub}'`, i);
      }
      if (eval_ !== -1) incr = 1;
      this.addToSet(sval, eval_, incr, type);
      return i + 3;
    }

    if (c === '?') {
      i++;
      if (i + 1 < s.length && charAt(s, i) !== ' ' && charAt(s, i + 1) !== '\t') {
        throw new QuartzParseError(`Illegal character after '?': ${charAt(s, i)}`, i);
      }
      if (type !== DAY_OF_WEEK && type !== DAY_OF_MONTH) {
        throw new QuartzParseError("'?' can only be specified for Day-of-Month or Day-of-Week.", i);
      }
      if (type === DAY_OF_WEEK && !this.lastdayOfMonth) {
        const val = this.daysOfMonth.last();
        if (val === NO_SPEC_INT) {
          throw new QuartzParseError(
            "'?' can only be specified for Day-of-Month -OR- Day-of-Week.",
            i,
          );
        }
      }
      this.addToSet(NO_SPEC_INT, -1, 0, type);
      return i;
    }

    if (c === '*' || c === '/') {
      if (c === '*' && i + 1 >= s.length) {
        this.addToSet(ALL_SPEC_INT, -1, incr, type);
        return i + 1;
      } else if (
        c === '/' &&
        (i + 1 >= s.length || charAt(s, i + 1) === ' ' || charAt(s, i + 1) === '\t')
      ) {
        throw new QuartzParseError("'/' must be followed by an integer.", i);
      } else if (c === '*') {
        i++;
      }
      c = charAt(s, i);
      if (c === '/') {
        i++;
        if (i >= s.length) throw new QuartzParseError('Unexpected end of string.', i);
        incr = this.getNumericValue(s, i);
        i++;
        if (incr > 10) i++;
        this.checkIncrementRange(incr, type, i);
      } else {
        incr = 1;
      }
      this.addToSet(ALL_SPEC_INT, -1, incr, type);
      return i;
    } else if (c === 'L') {
      i++;
      if (type === DAY_OF_MONTH) this.lastdayOfMonth = true;
      if (type === DAY_OF_WEEK) this.addToSet(7, 7, 0, type);
      if (type === DAY_OF_MONTH && s.length > i) {
        c = charAt(s, i);
        if (c === '-') {
          const vs = this.getValue(0, s, i + 1);
          this.lastdayOffset = vs.value;
          if (this.lastdayOffset > 30)
            throw new QuartzParseError('Offset from last day must be <= 30', i + 1);
          i = vs.pos;
        }
        if (s.length > i) {
          c = charAt(s, i);
          if (c === 'W') {
            this.nearestWeekday = true;
            i++;
          }
        }
      }
      return i;
    } else if (isDigit(c)) {
      let val = parseInt32(c);
      i++;
      if (i >= s.length) {
        this.addToSet(val, -1, -1, type);
      } else {
        c = charAt(s, i);
        if (isDigit(c)) {
          const vs = this.getValue(val, s, i);
          val = vs.value;
          i = vs.pos;
        }
        i = this.checkNext(i, s, val, type);
        return i;
      }
    } else {
      throw new QuartzParseError(`Unexpected character: ${c}`, i);
    }
    return i;
  }

  private checkIncrementRange(incr: number, type: number, idxPos: number): void {
    if (incr > 59 && (type === SECOND || type === MINUTE)) {
      throw new QuartzParseError(`Increment > 60 : ${incr}`, idxPos);
    } else if (incr > 23 && type === HOUR) {
      throw new QuartzParseError(`Increment > 24 : ${incr}`, idxPos);
    } else if (incr > 31 && type === DAY_OF_MONTH) {
      throw new QuartzParseError(`Increment > 31 : ${incr}`, idxPos);
    } else if (incr > 7 && type === DAY_OF_WEEK) {
      throw new QuartzParseError(`Increment > 7 : ${incr}`, idxPos);
    } else if (incr > 12 && type === MONTH) {
      throw new QuartzParseError(`Increment > 12 : ${incr}`, idxPos);
    }
  }

  private checkNext(pos: number, s: string, val: number, type: number): number {
    let end = -1;
    let i = pos;
    if (i >= s.length) {
      this.addToSet(val, end, -1, type);
      return i;
    }
    let c = charAt(s, pos);
    if (c === 'L') {
      if (type === DAY_OF_WEEK) {
        if (val < 1 || val > 7)
          throw new QuartzParseError('Day-of-Week values must be between 1 and 7', -1);
        this.lastdayOfWeek = true;
      } else {
        throw new QuartzParseError(`'L' option is not valid here. (pos=${i})`, i);
      }
      this.getSet(type).add(val);
      i++;
      return i;
    }
    if (c === 'W') {
      if (type === DAY_OF_MONTH) {
        this.nearestWeekday = true;
      } else {
        throw new QuartzParseError(`'W' option is not valid here. (pos=${i})`, i);
      }
      if (val > 31) {
        throw new QuartzParseError(
          "The 'W' option does not make sense with values larger than 31 (max number of days in a month)",
          i,
        );
      }
      this.getSet(type).add(val);
      i++;
      return i;
    }
    if (c === '#') {
      if (type !== DAY_OF_WEEK)
        throw new QuartzParseError(`'#' option is not valid here. (pos=${i})`, i);
      i++;
      try {
        this.nthdayOfWeek = parseInt32(substring(s, i));
        if (this.nthdayOfWeek < 1 || this.nthdayOfWeek > 5) throw new Error();
      } catch {
        throw new QuartzParseError("A numeric value between 1 and 5 must follow the '#' option", i);
      }
      this.getSet(type).add(val);
      i++;
      return i;
    }
    if (c === '-') {
      i++;
      c = charAt(s, i);
      const v = parseInt32(c);
      end = v;
      i++;
      if (i >= s.length) {
        this.addToSet(val, end, 1, type);
        return i;
      }
      c = charAt(s, i);
      if (isDigit(c)) {
        const vs = this.getValue(v, s, i);
        end = vs.value;
        i = vs.pos;
      }
      if (i < s.length && charAt(s, i) === '/') {
        i++;
        c = charAt(s, i);
        const v2 = parseInt32(c);
        i++;
        if (i >= s.length) {
          this.addToSet(val, end, v2, type);
          return i;
        }
        c = charAt(s, i);
        if (isDigit(c)) {
          const vs = this.getValue(v2, s, i);
          this.addToSet(val, end, vs.value, type);
          i = vs.pos;
          return i;
        } else {
          this.addToSet(val, end, v2, type);
          return i;
        }
      } else {
        this.addToSet(val, end, 1, type);
        return i;
      }
    }
    if (c === '/') {
      if (i + 1 >= s.length || charAt(s, i + 1) === ' ' || charAt(s, i + 1) === '\t') {
        throw new QuartzParseError("'/' must be followed by an integer.", i);
      }
      i++;
      c = charAt(s, i);
      const v2 = parseInt32(c);
      i++;
      if (i >= s.length) {
        this.checkIncrementRange(v2, type, i);
        this.addToSet(val, end, v2, type);
        return i;
      }
      c = charAt(s, i);
      if (isDigit(c)) {
        const vs = this.getValue(v2, s, i);
        this.checkIncrementRange(vs.value, type, i);
        this.addToSet(val, end, vs.value, type);
        i = vs.pos;
        return i;
      } else {
        throw new QuartzParseError(`Unexpected character '${c}' after '/'`, i);
      }
    }
    this.addToSet(val, end, 0, type);
    i++;
    return i;
  }

  private skipWhiteSpace(i: number, s: string): number {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    return i;
  }

  private addToSet(val: number, end: number, incr: number, type: number): void {
    const set = this.getSet(type);
    if (type === SECOND || type === MINUTE) {
      if ((val < 0 || val > 59 || end > 59) && val !== ALL_SPEC_INT) {
        throw new QuartzParseError('Minute and Second values must be between 0 and 59', -1);
      }
    } else if (type === HOUR) {
      if ((val < 0 || val > 23 || end > 23) && val !== ALL_SPEC_INT) {
        throw new QuartzParseError('Hour values must be between 0 and 23', -1);
      }
    } else if (type === DAY_OF_MONTH) {
      if ((val < 1 || val > 31 || end > 31) && val !== ALL_SPEC_INT && val !== NO_SPEC_INT) {
        throw new QuartzParseError('Day of month values must be between 1 and 31', -1);
      }
    } else if (type === MONTH) {
      if ((val < 1 || val > 12 || end > 12) && val !== ALL_SPEC_INT) {
        throw new QuartzParseError('Month values must be between 1 and 12', -1);
      }
    } else if (type === DAY_OF_WEEK) {
      if ((val === 0 || val > 7 || end > 7) && val !== ALL_SPEC_INT && val !== NO_SPEC_INT) {
        throw new QuartzParseError('Day-of-Week values must be between 1 and 7', -1);
      }
    }

    if ((incr === 0 || incr === -1) && val !== ALL_SPEC_INT) {
      set.add(val !== -1 ? val : NO_SPEC_INT);
      return;
    }

    let startAt = val;
    let stopAt = end;
    if (val === ALL_SPEC_INT && incr <= 0) {
      incr = 1;
      set.add(ALL_SPEC_INT);
    }
    if (type === SECOND || type === MINUTE) {
      if (stopAt === -1) stopAt = 59;
      if (startAt === -1 || startAt === ALL_SPEC_INT) startAt = 0;
    } else if (type === HOUR) {
      if (stopAt === -1) stopAt = 23;
      if (startAt === -1 || startAt === ALL_SPEC_INT) startAt = 0;
    } else if (type === DAY_OF_MONTH) {
      if (stopAt === -1) stopAt = 31;
      if (startAt === -1 || startAt === ALL_SPEC_INT) startAt = 1;
    } else if (type === MONTH) {
      if (stopAt === -1) stopAt = 12;
      if (startAt === -1 || startAt === ALL_SPEC_INT) startAt = 1;
    } else if (type === DAY_OF_WEEK) {
      if (stopAt === -1) stopAt = 7;
      if (startAt === -1 || startAt === ALL_SPEC_INT) startAt = 1;
    } else if (type === YEAR) {
      if (stopAt === -1) stopAt = MAX_YEAR;
      if (startAt === -1 || startAt === ALL_SPEC_INT) startAt = 1970;
    }

    let max = -1;
    if (stopAt < startAt) {
      switch (type) {
        case SECOND:
        case MINUTE:
          max = 60;
          break;
        case HOUR:
          max = 24;
          break;
        case MONTH:
          max = 12;
          break;
        case DAY_OF_WEEK:
          max = 7;
          break;
        case DAY_OF_MONTH:
          max = 31;
          break;
        case YEAR:
          throw new JavaRuntimeError(
            'IllegalArgumentException: Start year must be less than stop year',
          );
        default:
          throw new JavaRuntimeError('IllegalArgumentException: Unexpected type encountered');
      }
      stopAt += max;
    }
    // incr가 0 이하인 경우는 위에서 걸러진다(무한 반복 방지 확인)
    if (incr <= 0) throw new JavaRuntimeError(`IllegalArgumentException: increment ${incr}`);
    for (let i = startAt; i <= stopAt; i += incr) {
      if (max === -1) {
        set.add(i);
      } else {
        let i2 = i % max;
        if (i2 === 0 && (type === MONTH || type === DAY_OF_WEEK || type === DAY_OF_MONTH)) i2 = max;
        set.add(i2);
      }
    }
  }

  private getSet(type: number): IntSet {
    switch (type) {
      case SECOND:
        return this.seconds;
      case MINUTE:
        return this.minutes;
      case HOUR:
        return this.hours;
      case DAY_OF_MONTH:
        return this.daysOfMonth;
      case MONTH:
        return this.months;
      case DAY_OF_WEEK:
        return this.daysOfWeek;
      default:
        return this.years;
    }
  }

  private getValue(v: number, s: string, i: number): ValueSet {
    let c = charAt(s, i);
    let s1 = String(v);
    while (isDigit(c)) {
      s1 += c;
      i++;
      if (i >= s.length) break;
      c = charAt(s, i);
    }
    return { pos: i < s.length ? i : i + 1, value: parseInt32(s1) };
  }

  private getNumericValue(s: string, i: number): number {
    // 원본 findNextWhiteSpace는 조건식 때문에 항상 문자열 끝까지 간다
    return parseInt32(substring(s, i, s.length));
  }

  private getMonthNumber(s: string): number {
    return MONTH_MAP[s] ?? -1;
  }

  private getDayOfWeekNumber(s: string): number {
    return DAY_MAP[s] ?? -1;
  }

  /**
   * `afterTime` 이후 첫 발화 시각(epoch ms). 없으면 null.
   * @throws Error 파싱은 통과했지만 필드 집합이 비어 계산할 수 없는 표현식(2.3.2의 `L * * * * ?` 등)
   */
  getTimeAfter(afterTimeMs: number, zone: JavaTimeZone): number | null {
    const cl = new JavaCalendar(zone);
    const afterTime = afterTimeMs + 1000;
    cl.setTime(afterTime);
    cl.set(Field.MILLISECOND, 0);

    for (;;) {
      if (cl.get(Field.YEAR) > 2999) return null;

      let t: number;
      let sec = cl.get(Field.SECOND);
      let min = cl.get(Field.MINUTE);

      let st = this.seconds.ceiling(sec);
      if (st !== undefined) {
        sec = st;
      } else {
        sec = this.seconds.first();
        min++;
        cl.set(Field.MINUTE, min);
      }
      cl.set(Field.SECOND, sec);

      min = cl.get(Field.MINUTE);
      let hr = cl.get(Field.HOUR_OF_DAY);
      t = -1;
      st = this.minutes.ceiling(min);
      if (st !== undefined) {
        t = min;
        min = st;
      } else {
        min = this.minutes.first();
        hr++;
      }
      if (min !== t) {
        cl.set(Field.SECOND, 0);
        cl.set(Field.MINUTE, min);
        setCalendarHour(cl, hr);
        continue;
      }
      cl.set(Field.MINUTE, min);

      hr = cl.get(Field.HOUR_OF_DAY);
      let day = cl.get(Field.DAY_OF_MONTH);
      t = -1;
      st = this.hours.ceiling(hr);
      if (st !== undefined) {
        t = hr;
        hr = st;
      } else {
        hr = this.hours.first();
        day++;
      }
      if (hr !== t) {
        cl.set(Field.SECOND, 0);
        cl.set(Field.MINUTE, 0);
        cl.set(Field.DAY_OF_MONTH, day);
        setCalendarHour(cl, hr);
        continue;
      }
      cl.set(Field.HOUR_OF_DAY, hr);

      day = cl.get(Field.DAY_OF_MONTH);
      let mon = cl.get(Field.MONTH) + 1;
      t = -1;
      let tmon = mon;

      const dayOfMSpec = !this.daysOfMonth.has(NO_SPEC_INT);
      const dayOfWSpec = !this.daysOfWeek.has(NO_SPEC_INT);
      if (dayOfMSpec && !dayOfWSpec) {
        st = this.daysOfMonth.ceiling(day);
        if (this.lastdayOfMonth) {
          if (!this.nearestWeekday) {
            t = day;
            day = lastDayOfMonth(mon, cl.get(Field.YEAR));
            day -= this.lastdayOffset;
            if (t > day) {
              mon++;
              if (mon > 12) {
                mon = 1;
                tmon = 3333;
                cl.addYears(1);
              }
              day = 1;
            }
          } else {
            t = day;
            day = lastDayOfMonth(mon, cl.get(Field.YEAR));
            day -= this.lastdayOffset;
            const tcal = new JavaCalendar(zone);
            tcal.setTime(0);
            tcal.set(Field.MILLISECOND, 0);
            tcal.set(Field.SECOND, 0);
            tcal.set(Field.MINUTE, 0);
            tcal.set(Field.HOUR_OF_DAY, 0);
            tcal.set(Field.DAY_OF_MONTH, day);
            tcal.set(Field.MONTH, mon - 1);
            tcal.set(Field.YEAR, cl.get(Field.YEAR));
            const ldom = lastDayOfMonth(mon, cl.get(Field.YEAR));
            const dow = tcal.get(Field.DAY_OF_WEEK);
            if (dow === SATURDAY && day === 1) day += 2;
            else if (dow === SATURDAY) day -= 1;
            else if (dow === SUNDAY && day === ldom) day -= 2;
            else if (dow === SUNDAY) day += 1;
            tcal.set(Field.SECOND, sec);
            tcal.set(Field.MINUTE, min);
            tcal.set(Field.HOUR_OF_DAY, hr);
            tcal.set(Field.DAY_OF_MONTH, day);
            tcal.set(Field.MONTH, mon - 1);
            const nTime = tcal.getTime();
            if (nTime < afterTime) {
              day = 1;
              mon++;
            }
          }
        } else if (this.nearestWeekday) {
          t = day;
          day = this.daysOfMonth.first();
          const tcal = new JavaCalendar(zone);
          tcal.setTime(0);
          tcal.set(Field.MILLISECOND, 0);
          tcal.set(Field.SECOND, 0);
          tcal.set(Field.MINUTE, 0);
          tcal.set(Field.HOUR_OF_DAY, 0);
          tcal.set(Field.DAY_OF_MONTH, day);
          tcal.set(Field.MONTH, mon - 1);
          tcal.set(Field.YEAR, cl.get(Field.YEAR));
          const ldom = lastDayOfMonth(mon, cl.get(Field.YEAR));
          const dow = tcal.get(Field.DAY_OF_WEEK);
          if (dow === SATURDAY && day === 1) day += 2;
          else if (dow === SATURDAY) day -= 1;
          else if (dow === SUNDAY && day === ldom) day -= 2;
          else if (dow === SUNDAY) day += 1;
          tcal.set(Field.SECOND, sec);
          tcal.set(Field.MINUTE, min);
          tcal.set(Field.HOUR_OF_DAY, hr);
          tcal.set(Field.DAY_OF_MONTH, day);
          tcal.set(Field.MONTH, mon - 1);
          const nTime = tcal.getTime();
          if (nTime < afterTime) {
            day = this.daysOfMonth.first();
            mon++;
          }
        } else if (st !== undefined) {
          t = day;
          day = st;
          const lastDay = lastDayOfMonth(mon, cl.get(Field.YEAR));
          if (day > lastDay) {
            day = this.daysOfMonth.first();
            mon++;
          }
        } else {
          day = this.daysOfMonth.first();
          mon++;
        }
        if (day !== t || mon !== tmon) {
          cl.set(Field.SECOND, 0);
          cl.set(Field.MINUTE, 0);
          cl.set(Field.HOUR_OF_DAY, 0);
          cl.set(Field.DAY_OF_MONTH, day);
          cl.set(Field.MONTH, mon - 1);
          continue;
        }
      } else if (dayOfWSpec && !dayOfMSpec) {
        if (this.lastdayOfWeek) {
          const dow = this.daysOfWeek.first();
          const cDow = cl.get(Field.DAY_OF_WEEK);
          let daysToAdd = 0;
          if (cDow < dow) daysToAdd = dow - cDow;
          if (cDow > dow) daysToAdd = dow + (7 - cDow);
          const lDay = lastDayOfMonth(mon, cl.get(Field.YEAR));
          if (day + daysToAdd > lDay) {
            cl.set(Field.SECOND, 0);
            cl.set(Field.MINUTE, 0);
            cl.set(Field.HOUR_OF_DAY, 0);
            cl.set(Field.DAY_OF_MONTH, 1);
            cl.set(Field.MONTH, mon);
            continue;
          }
          while (day + daysToAdd + 7 <= lDay) daysToAdd += 7;
          day += daysToAdd;
          if (daysToAdd > 0) {
            cl.set(Field.SECOND, 0);
            cl.set(Field.MINUTE, 0);
            cl.set(Field.HOUR_OF_DAY, 0);
            cl.set(Field.DAY_OF_MONTH, day);
            cl.set(Field.MONTH, mon - 1);
            continue;
          }
        } else if (this.nthdayOfWeek !== 0) {
          const dow = this.daysOfWeek.first();
          const cDow = cl.get(Field.DAY_OF_WEEK);
          let daysToAdd = 0;
          if (cDow < dow) daysToAdd = dow - cDow;
          else if (cDow > dow) daysToAdd = dow + (7 - cDow);
          const dayShifted = daysToAdd > 0;
          day += daysToAdd;
          let weekOfMonth = Math.trunc(day / 7);
          if (day % 7 > 0) weekOfMonth++;
          daysToAdd = (this.nthdayOfWeek - weekOfMonth) * 7;
          day += daysToAdd;
          if (daysToAdd < 0 || day > lastDayOfMonth(mon, cl.get(Field.YEAR))) {
            cl.set(Field.SECOND, 0);
            cl.set(Field.MINUTE, 0);
            cl.set(Field.HOUR_OF_DAY, 0);
            cl.set(Field.DAY_OF_MONTH, 1);
            cl.set(Field.MONTH, mon);
            continue;
          } else if (daysToAdd > 0 || dayShifted) {
            cl.set(Field.SECOND, 0);
            cl.set(Field.MINUTE, 0);
            cl.set(Field.HOUR_OF_DAY, 0);
            cl.set(Field.DAY_OF_MONTH, day);
            cl.set(Field.MONTH, mon - 1);
            continue;
          }
        } else {
          const cDow = cl.get(Field.DAY_OF_WEEK);
          let dow = this.daysOfWeek.first();
          const next = this.daysOfWeek.ceiling(cDow);
          if (next !== undefined) dow = next;
          let daysToAdd = 0;
          if (cDow < dow) daysToAdd = dow - cDow;
          if (cDow > dow) daysToAdd = dow + (7 - cDow);
          const lDay = lastDayOfMonth(mon, cl.get(Field.YEAR));
          if (day + daysToAdd > lDay) {
            cl.set(Field.SECOND, 0);
            cl.set(Field.MINUTE, 0);
            cl.set(Field.HOUR_OF_DAY, 0);
            cl.set(Field.DAY_OF_MONTH, 1);
            cl.set(Field.MONTH, mon);
            continue;
          } else if (daysToAdd > 0) {
            cl.set(Field.SECOND, 0);
            cl.set(Field.MINUTE, 0);
            cl.set(Field.HOUR_OF_DAY, 0);
            cl.set(Field.DAY_OF_MONTH, day + daysToAdd);
            cl.set(Field.MONTH, mon - 1);
            continue;
          }
        }
      } else {
        throw new Error(
          'Support for specifying both a day-of-week AND a day-of-month parameter is not implemented.',
        );
      }
      cl.set(Field.DAY_OF_MONTH, day);

      mon = cl.get(Field.MONTH) + 1;
      let year = cl.get(Field.YEAR);
      t = -1;
      if (year > MAX_YEAR) return null;
      st = this.months.ceiling(mon);
      if (st !== undefined) {
        t = mon;
        mon = st;
      } else {
        mon = this.months.first();
        year++;
      }
      if (mon !== t) {
        cl.set(Field.SECOND, 0);
        cl.set(Field.MINUTE, 0);
        cl.set(Field.HOUR_OF_DAY, 0);
        cl.set(Field.DAY_OF_MONTH, 1);
        cl.set(Field.MONTH, mon - 1);
        cl.set(Field.YEAR, year);
        continue;
      }
      cl.set(Field.MONTH, mon - 1);

      year = cl.get(Field.YEAR);
      st = this.years.ceiling(year);
      if (st !== undefined) {
        t = year;
        year = st;
      } else {
        return null;
      }
      if (year !== t) {
        cl.set(Field.SECOND, 0);
        cl.set(Field.MINUTE, 0);
        cl.set(Field.HOUR_OF_DAY, 0);
        cl.set(Field.DAY_OF_MONTH, 1);
        cl.set(Field.MONTH, 0);
        cl.set(Field.YEAR, year);
        continue;
      }
      cl.set(Field.YEAR, year);
      return cl.getTime();
    }
  }
}

/** 없는 시각(DST 시작)으로 시를 맞추면 Java는 한 시간 뒤로 다시 맞춘다 */
function setCalendarHour(cal: JavaCalendar, hour: number): void {
  cal.set(Field.HOUR_OF_DAY, hour);
  if (cal.get(Field.HOUR_OF_DAY) !== hour && hour !== 24) {
    cal.set(Field.HOUR_OF_DAY, hour + 1);
  }
}

/** monthNum은 1~12 */
function lastDayOfMonth(monthNum: number, year: number): number {
  if (monthNum < 1 || monthNum > 12) throw new Error(`Illegal month number: ${monthNum}`);
  return daysInMonth(year, monthNum - 1);
}
