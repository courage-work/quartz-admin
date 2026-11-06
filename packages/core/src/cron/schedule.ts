import { type JavaTimeZone, resolveJavaTimeZone } from '../tz/java-time-zone.js';
import type { QuartzCronExpression } from './quartz-cron-expression.js';
import { parseCron } from './validate.js';

export interface CronSchedule {
  /** 대문자로 맞추고 공백을 정리한 표현식 */
  readonly expression: string;
  readonly timeZone: JavaTimeZone;
  /** `afterMs` 이후 첫 발화 시각. `CronExpression.getTimeAfter`와 같다 */
  next(afterMs: number): number | null;
  /** `afterMs` 이후 발화 시각 `count`개(그보다 적을 수 있음) */
  nextTimes(afterMs: number, count: number): number[];
}

/**
 * 검증한 표현식과 Java 타임존 ID로 계산기를 만든다.
 * @throws CronValidationError 지원하지 않거나 잘못된 표현식
 * @throws UnsupportedTimeZoneError
 */
export function cronSchedule(expression: string, timeZoneId: string): CronSchedule {
  return fromParsed(parseCron(expression), resolveJavaTimeZone(timeZoneId));
}

export function fromParsed(parsed: QuartzCronExpression, timeZone: JavaTimeZone): CronSchedule {
  return {
    expression: parsed.expression,
    timeZone,
    next: (afterMs) => parsed.getTimeAfter(afterMs, timeZone),
    nextTimes(afterMs, count) {
      const out: number[] = [];
      let cursor: number | null = afterMs;
      while (out.length < count) {
        cursor = parsed.getTimeAfter(cursor, timeZone);
        if (cursor === null) break;
        out.push(cursor);
      }
      return out;
    },
  };
}
