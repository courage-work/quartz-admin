/**
 * Java `java.util.TimeZone.getTimeZone(id)` 해석을 따라 IANA 타임존으로 바꾼다 (TRD §6.1 `tz`).
 *
 * Quartz는 `CRON_TRIGGERS.TIME_ZONE_ID`를 `TimeZone.getTimeZone()`으로 읽는다. 이 함수는 모르는 ID를 오류 없이 GMT로
 * 바꾸므로, 노드가 실제로 쓰는 타임존을 알려면 같은 규칙을 따라야 한다.
 *
 * 1. JDK가 아는 ID(`JAVA_ZONE_IDS`, 대소문자 구분)면 그 ID. 3글자 축약 ID는 `ZoneId.SHORT_IDS` 매핑을 쓴다
 *    (`EST`, `MST`, `HST`는 고정 오프셋, `PST`는 `America/Los_Angeles`).
 * 2. `GMT+h`, `GMT+hh`, `GMT+hhmm`, `GMT+hh:mm` 형식(시 0~23, 분 0~59)이면 고정 오프셋.
 * 3. 나머지는 GMT. `UTC+9`, 소문자 `asia/seoul`, 앞뒤 공백도 GMT다.
 */
import { FixedOffsetZone, IANAZone, type Zone } from 'luxon';
import { JAVA_ZONE_ALIASES, JAVA_ZONE_IDS } from './java-zone-ids.js';

const KNOWN = new Set(JAVA_ZONE_IDS);

export interface JavaTimeZone {
  /** 입력한 ID */
  readonly requestedId: string;
  /** Java가 실제로 쓰는 ID (`TimeZone.getID()`). 모르는 ID면 `GMT` */
  readonly javaId: string;
  /** 모르는 ID라 GMT로 대체됐는지 */
  readonly fallbackToGmt: boolean;
  /** 계산에 쓰는 Luxon 타임존 */
  readonly zone: Zone;
  /** epoch ms 시점의 UTC 오프셋(ms) */
  offset(epochMs: number): number;
}

class ResolvedZone implements JavaTimeZone {
  private readonly cache = new Map<number, number>();

  constructor(
    readonly requestedId: string,
    readonly javaId: string,
    readonly fallbackToGmt: boolean,
    readonly zone: Zone,
  ) {}

  offset(epochMs: number): number {
    if (this.zone.isUniversal) return this.zone.offset(epochMs) * 60_000;
    // 오프셋은 분 단위로 바뀌므로 분 단위로 캐시한다(cron 계산 한 번에 같은 시점을 여러 번 묻는다)
    const key = Math.floor(epochMs / 60_000);
    let value = this.cache.get(key);
    if (value === undefined) {
      value = this.zone.offset(epochMs) * 60_000;
      if (this.cache.size > 4096) this.cache.clear();
      this.cache.set(key, value);
    }
    return value;
  }
}

const CUSTOM = /^GMT([+-])(\d{1,4}|\d{1,2}:\d{2})$/;

/** `GMT+9`, `GMT+0900`, `GMT+09:00` → 분 단위 오프셋. Java `ZoneInfoFile`/`TimeZone.parseCustomTimeZone` 규칙 */
function parseCustom(id: string): number | null {
  const m = CUSTOM.exec(id);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const body = m[2]!;
  let hours: number;
  let minutes: number;
  if (body.includes(':')) {
    const [h, mm] = body.split(':');
    hours = Number(h);
    minutes = Number(mm);
  } else if (body.length <= 2) {
    hours = Number(body);
    minutes = 0;
  } else {
    // 3~4자리는 hhmm(3자리는 hmm)
    hours = Number(body.slice(0, body.length - 2));
    minutes = Number(body.slice(-2));
  }
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

function customId(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `GMT${sign}${hh}:${mm}`;
}

/** `-05:00` 같은 오프셋 문자열 → 분 */
function offsetMinutes(value: string): number | null {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const GMT = FixedOffsetZone.utcInstance;
const cache = new Map<string, JavaTimeZone>();

export class UnsupportedTimeZoneError extends Error {
  constructor(readonly javaId: string) {
    super(`이 타임존은 지원하지 않습니다: ${javaId}`);
    this.name = 'UnsupportedTimeZoneError';
  }
}

/**
 * Java 타임존 ID를 해석한다.
 * @throws UnsupportedTimeZoneError JDK는 알지만 이 런타임(ICU)에 데이터가 없는 ID. 계산이 달라지므로 거부한다
 */
export function resolveJavaTimeZone(id: string): JavaTimeZone {
  let resolved = cache.get(id);
  if (resolved) return resolved;

  if (KNOWN.has(id)) {
    const target = JAVA_ZONE_ALIASES[id] ?? id;
    const fixed = offsetMinutes(target);
    let zone: Zone;
    if (fixed !== null) {
      zone = FixedOffsetZone.instance(fixed);
    } else if (target === 'UTC' || target === 'GMT') {
      zone = GMT;
    } else {
      const iana = IANAZone.create(target);
      if (!iana.isValid) throw new UnsupportedTimeZoneError(id);
      zone = iana;
    }
    resolved = new ResolvedZone(id, id, false, zone);
  } else {
    const custom = parseCustom(id);
    resolved =
      custom === null
        ? new ResolvedZone(id, 'GMT', true, GMT)
        : new ResolvedZone(id, customId(custom), false, FixedOffsetZone.instance(custom));
  }
  cache.set(id, resolved);
  return resolved;
}
