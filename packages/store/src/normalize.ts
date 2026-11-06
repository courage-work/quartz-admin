/**
 * Quartz 테이블 값 정규화 (TRD §5.4). DB 4종 드라이버가 돌려주는 값을 하나의 JS 형태로 맞춘다.
 * 대상 DB에서 읽은 값에만 쓴다. 쓰기 경로는 불리언과 BLOB 컬럼을 건드리지 않는다.
 */

/** 정수 컬럼. SQL NULL만 `null`이다. REPEAT_COUNT의 -1(무한 반복)처럼 음수도 그대로 둔다 */
export function readLong(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return toSafeInteger(value);
  if (typeof value === 'bigint') return toSafeInteger(Number(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !/^-?\d+(\.0+)?$/.test(trimmed)) {
      throw new TypeError(`정수로 읽을 수 없는 값입니다: ${describe(value)}`);
    }
    return toSafeInteger(Number(trimmed));
  }
  throw new TypeError(`정수로 읽을 수 없는 값입니다: ${describe(value)}`);
}

/**
 * 시각 컬럼(epoch ms). Quartz는 "값 없음"을 경로에 따라 NULL, -1, 0으로 저장하고 `> 0`만 유효로 본다.
 * 그래서 NULL과 0 이하를 모두 `null`로 바꾼다.
 */
export function readTime(value: unknown): number | null {
  const n = readLong(value);
  return n === null || n <= 0 ? null : n;
}

const TRUE_STRINGS = new Set(['1', 'Y', 'T', 'TRUE']);
const FALSE_STRINGS = new Set(['0', 'N', 'F', 'FALSE']);

/**
 * 불리언 컬럼. Quartz 스키마에 따라 `'1'`/`'0'`, `'Y'`/`'N'`, `'T'`/`'F'`, 네이티브 BOOLEAN, 숫자 1/0으로 저장된다.
 * CHAR 컬럼의 공백 패딩과 대소문자는 무시한다. 알아볼 수 없는 값은 `null`(모름)이다.
 */
export function readBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (Number(value) === 1) return true;
    if (Number(value) === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const s = value.trim().toUpperCase();
    if (TRUE_STRINGS.has(s)) return true;
    if (FALSE_STRINGS.has(s)) return false;
    return null;
  }
  if (Buffer.isBuffer(value) && value.length === 1) {
    // MySQL BIT(1)
    return value[0] === 1;
  }
  return null;
}

/** BLOB 컬럼(JOB_DATA 등). 비어 있으면 `null`이다 */
export function readBlob(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  let buf: Buffer;
  if (Buffer.isBuffer(value)) buf = value;
  else if (value instanceof Uint8Array)
    buf = Buffer.from(value.buffer, value.byteOffset, value.length);
  else throw new TypeError(`BLOB으로 읽을 수 없는 값입니다: ${describe(value)}`);
  return buf.length === 0 ? null : buf;
}

/** 문자열 컬럼. Oracle은 빈 문자열을 NULL로 저장하므로 둘을 같은 값(`null`)으로 본다 */
export function readString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  throw new TypeError(`문자열로 읽을 수 없는 값입니다: ${describe(value)}`);
}

function toSafeInteger(n: number): number {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`JS 정수 범위를 벗어난 값입니다: ${n}`);
  }
  return n;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 40));
  if (typeof value === 'object' && value !== null) return value.constructor?.name ?? 'object';
  return typeof value;
}
