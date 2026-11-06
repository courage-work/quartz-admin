/**
 * 실제 Quartz(2.3.2, 2.5.2)와 JDK로 만든 벡터(test/vectors/quartz.json)와 이식본을 비교한다 (TRD §6.2).
 * 벡터를 다시 만들려면 `pnpm --filter @qa/core vectors`(Docker 필요).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cronSchedule } from './cron/schedule.js';
import { validateCron } from './cron/validate.js';
import { parseJavaProperties } from './props/java-properties.js';
import { CronTriggerCalc } from './triggers/cron-trigger.js';
import { SimpleTriggerCalc } from './triggers/simple-trigger.js';
import { resolveJavaTimeZone } from './tz/java-time-zone.js';

interface CronVector {
  id: string;
  cron: string;
  timeZone: string;
  from?: number;
  resolvedTimeZone?: string;
  next?: number[];
  error?: string;
  runtimeError?: string;
  v252?: unknown;
}

interface AfterResult {
  after: number;
  next: number | null;
}

interface TriggerVector {
  id: string;
  error?: string;
  runtimeError?: string;
  fireTimes?: number[];
  afterResults?: AfterResult[];
  normalizedStartTime?: number;
  v252?: unknown;
  [key: string]: unknown;
}

interface Vectors {
  quartzVersions: string[];
  cron: CronVector[];
  cronTriggers: TriggerVector[];
  simpleTriggers: TriggerVector[];
  timeZones: { id: string; resolvedId: string; at: number[]; offsets: number[] }[];
  allTimeZonesAt: string[];
  allTimeZones: (string | number)[][];
  properties: { id: string; text: string; entries?: Record<string, string>; error?: string }[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../test/vectors/quartz.json', import.meta.url), 'utf8'),
) as Vectors;

const time = (v: unknown): number => (typeof v === 'number' ? v : Date.parse(String(v)));

describe('cron 표현식 (CronExpression.getTimeAfter)', () => {
  const valid = vectors.cron.filter((v) => v.id.startsWith('c'));
  const invalid = vectors.cron.filter((v) => v.id.startsWith('bad'));

  it('정상 조합이 300개 이상이고 DST·L·W·#·윤년을 포함한다', () => {
    const combos = valid.filter((v) => v.next && !v.v252);
    expect(combos.length).toBeGreaterThanOrEqual(300);
    for (const token of ['L', 'W', '#', 'LW']) {
      expect(
        combos.some(
          (v) => v.cron.split(' ')[3]?.includes(token) || v.cron.split(' ')[5]?.includes(token),
        ),
      ).toBe(true);
    }
    expect(combos.some((v) => v.timeZone === 'America/New_York')).toBe(true);
    expect(combos.some((v) => v.timeZone === 'Europe/Berlin')).toBe(true);
    expect(combos.some((v) => v.cron === '0 0 0 29 2 ?')).toBe(true);
  });

  it('두 Quartz 버전이 같게 계산하는 표현식은 모두 받아들이고 시각이 일치한다', () => {
    const mismatches: string[] = [];
    for (const v of valid.filter((x) => !x.v252)) {
      const result = validateCron(v.cron);
      if (!result.ok) {
        mismatches.push(`${v.id} ${v.cron}: 거부됨(${result.error.message})`);
        continue;
      }
      const actual = cronSchedule(v.cron, v.timeZone).nextTimes(v.from!, 20);
      if (JSON.stringify(actual) !== JSON.stringify(v.next)) {
        const i = actual.findIndex((t, j) => t !== v.next![j]);
        mismatches.push(
          `${v.id} ${v.cron} [${v.timeZone}] from ${new Date(v.from!).toISOString()} #${i}: ` +
            `기대 ${v.next![i] !== undefined ? new Date(v.next![i]).toISOString() : '없음'}, ` +
            `실제 ${actual[i] !== undefined ? new Date(actual[i]).toISOString() : '없음'}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('두 Quartz 버전 결과가 다른 표현식은 거부한다', () => {
    const accepted = valid
      .filter((v) => v.v252)
      .filter((v) => validateCron(v.cron).ok)
      .map((v) => v.cron);
    expect([...new Set(accepted)]).toEqual([]);
  });

  it('잘못된 표현식 목록은 모두 거부한다(Quartz가 거부하거나 도구가 지원하지 않는 것)', () => {
    const accepted = invalid.filter((v) => validateCron(v.cron).ok).map((v) => v.cron);
    expect(accepted).toEqual([]);
  });

  it('Quartz가 거부하는 표현식은 도구도 반드시 거부한다', () => {
    const rejectedByQuartz = vectors.cron.filter(
      (v) => v.error || v.runtimeError || (v.v252 as { error?: string } | undefined)?.error,
    );
    expect(rejectedByQuartz.length).toBeGreaterThan(20);
    expect(rejectedByQuartz.filter((v) => validateCron(v.cron).ok).map((v) => v.cron)).toEqual([]);
  });
});

function triggerSequence(
  first: number | null,
  count: number,
  next: (t: number) => number | null,
): number[] {
  const out: number[] = [];
  let cursor = first;
  while (cursor !== null && out.length < count) {
    out.push(cursor);
    cursor = next(cursor);
  }
  return out;
}

describe('CronTrigger (CronTriggerImpl)', () => {
  for (const v of vectors.cronTriggers) {
    it(v.id, () => {
      expect(v.v252).toBeUndefined();
      const spec = {
        cronExpression: String(v.cron),
        timeZoneId: String(v.timeZone),
        startTime: time(v.startTime),
        endTime: v.endTime == null ? null : time(v.endTime),
      };
      if (v.error || v.runtimeError) {
        expect(() => new CronTriggerCalc(spec)).toThrow();
        return;
      }
      const calc = new CronTriggerCalc(spec);
      expect(calc.startTime).toBe(v.normalizedStartTime);
      expect(
        triggerSequence(calc.firstFireTime(), Number(v.count), (t) => calc.fireTimeAfter(t)),
      ).toEqual(v.fireTimes);
      for (const a of v.afterResults ?? []) {
        expect(calc.fireTimeAfter(a.after), `after ${new Date(a.after).toISOString()}`).toBe(
          a.next,
        );
      }
    });
  }
});

describe('SimpleTrigger (SimpleTriggerImpl)', () => {
  for (const v of vectors.simpleTriggers) {
    it(v.id, () => {
      expect(v.v252).toBeUndefined();
      const spec = {
        startTime: time(v.startTime),
        endTime: v.endTime == null ? null : time(v.endTime),
        repeatCount: Number(v.repeatCount),
        repeatInterval: Number(v.repeatInterval),
        timesTriggered: Number(v.timesTriggered ?? 0),
      };
      if (v.error) {
        expect(() => new SimpleTriggerCalc(spec)).toThrow();
        return;
      }
      const calc = new SimpleTriggerCalc(spec);
      expect(
        triggerSequence(calc.firstFireTime(), Number(v.count), (t) => calc.fireTimeAfter(t)),
      ).toEqual(v.fireTimes);
      for (const a of v.afterResults ?? []) {
        expect(calc.fireTimeAfter(a.after), `after ${new Date(a.after).toISOString()}`).toBe(
          a.next,
        );
      }
    });
  }
});

describe('Java 타임존 (TimeZone.getTimeZone)', () => {
  it('Java가 해석하는 ID와 오프셋이 같다(축약 ID, 사용자 지정 오프셋, 모르는 ID)', () => {
    for (const v of vectors.timeZones) {
      const tz = resolveJavaTimeZone(v.id);
      expect(tz.javaId, JSON.stringify(v.id)).toBe(v.resolvedId);
      v.at.forEach((t, i) => expect(tz.offset(t), `${v.id} @ ${t}`).toBe(v.offsets[i]));
    }
  });

  it('JDK가 아는 모든 ID에서 오프셋이 같다', () => {
    const at = vectors.allTimeZonesAt.map(time);
    const mismatches: string[] = [];
    for (const [id, , , ...offsets] of vectors.allTimeZones) {
      try {
        const tz = resolveJavaTimeZone(String(id));
        at.forEach((t, i) => {
          if (tz.offset(t) !== offsets[i])
            mismatches.push(
              `${String(id)} @ ${new Date(t).toISOString()}: ${tz.offset(t)} ≠ ${String(offsets[i])}`,
            );
        });
      } catch (e) {
        mismatches.push(`${String(id)}: ${(e as Error).message}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('java.util.Properties', () => {
  for (const v of vectors.properties) {
    it(v.id, () => {
      if (v.error) {
        expect(() => parseJavaProperties(v.text)).toThrow();
        return;
      }
      expect(Object.fromEntries(parseJavaProperties(v.text))).toEqual(v.entries);
    });
  }
});
