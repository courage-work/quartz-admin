/**
 * cron 표현식 검증 (TRD §6, PRD R2).
 *
 * 도구가 받는 표현식은 "Quartz 2.3.2와 2.5.x가 모두 받아들이고 같은 시각을 계산하는 것" 중 이식본이 Quartz와 같은 결과를
 * 내는 것으로 한정한다. 그래서 Quartz 파서보다 엄격한 문법을 먼저 확인한다.
 *
 * 지원하지 않는 것(Quartz는 받아들이지만 거부함)
 * - `W`를 29일 이후 날짜에 쓰는 것(`29W`~`31W`): 그 날이 없는 달에서 2.3.2와 2.5.x 결과가 다르다
 * - `W`를 다른 날짜와 함께 쓰는 것(`1W,15`): 버전마다 해석이 다르다
 * - 필드 8개 이상: 2.3.2는 나머지를 무시하고 2.5.x는 거부한다
 * - 이름에 증가값을 붙인 것(`JAN-MAR/2`): 2.3.2는 증가값을 조용히 무시한다
 * - 증가값 0, 1970년 이전·2999년 이후 연도, `?a`처럼 뒤에 붙은 문자
 */
import { QuartzCronExpression, QuartzParseError } from './quartz-cron-expression.js';

export const CRON_FIELDS = ['초', '분', '시', '일', '월', '요일', '연도'] as const;
export type CronFieldName = (typeof CRON_FIELDS)[number];

export type CronErrorCode =
  /** 필드 수나 문법이 틀림 */
  | 'SYNTAX'
  /** 값이 범위를 벗어남 */
  | 'RANGE'
  /** Quartz는 받아들이지만 도구가 지원하지 않음 */
  | 'UNSUPPORTED'
  /** Quartz 파서가 거부함 */
  | 'QUARTZ';

export interface CronError {
  code: CronErrorCode;
  /** 문제가 된 필드. 표현식 전체 문제면 없음 */
  field?: CronFieldName;
  /** 한국어 설명 */
  message: string;
  /** Quartz 원본 오류 메시지(code가 QUARTZ일 때) */
  quartzMessage?: string;
}

export type CronValidation =
  { ok: true; expression: string; parsed: QuartzCronExpression } | { ok: false; error: CronError };

export class CronValidationError extends Error {
  constructor(readonly error: CronError) {
    super(error.message);
    this.name = 'CronValidationError';
  }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  name: CronFieldName;
  min: number;
  max: number;
  names?: string[];
  /** 이름의 숫자 값 = 인덱스 + nameBase */
  nameBase?: number;
}

const SPECS: FieldSpec[] = [
  { name: '초', min: 0, max: 59 },
  { name: '분', min: 0, max: 59 },
  { name: '시', min: 0, max: 23 },
  { name: '일', min: 1, max: 31 },
  { name: '월', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: '요일', min: 1, max: 7, names: DAYS, nameBase: 1 },
  { name: '연도', min: 1970, max: 2999 },
];

class Invalid extends Error {
  constructor(readonly error: CronError) {
    super(error.message);
  }
}

function fail(code: CronErrorCode, field: CronFieldName | undefined, message: string): never {
  throw new Invalid({ code, ...(field ? { field } : {}), message });
}

const NUMBER = /^\d+$/;

/** 숫자나 이름 하나 → 값. 이름은 월·요일만 */
function value(spec: FieldSpec, token: string, allowName: boolean): number {
  if (NUMBER.test(token)) {
    const v = Number(token);
    if (v < spec.min || v > spec.max) {
      fail(
        'RANGE',
        spec.name,
        `${spec.name} 값은 ${spec.min}~${spec.max} 사이여야 합니다: ${token}`,
      );
    }
    return v;
  }
  if (allowName && spec.names) {
    const i = spec.names.indexOf(token);
    if (i >= 0) return i + (spec.nameBase ?? 0);
    fail(
      'SYNTAX',
      spec.name,
      `${spec.name} 이름이 올바르지 않습니다: ${token} (${spec.names.join(', ')})`,
    );
  }
  fail('SYNTAX', spec.name, `${spec.name} 필드에 쓸 수 없는 값입니다: ${token}`);
}

/** `*`, `n`, `n-m`, `*\/k`, `n/k`, `n-m/k` 하나 */
function item(spec: FieldSpec, raw: string): void {
  const [base, step, ...rest] = raw.split('/');
  if (rest.length > 0 || base === undefined || base === '') {
    fail('SYNTAX', spec.name, `${spec.name} 필드 문법이 올바르지 않습니다: ${raw}`);
  }
  if (step !== undefined) {
    if (!NUMBER.test(step))
      fail('SYNTAX', spec.name, `'/' 다음에는 증가값(숫자)이 와야 합니다: ${raw}`);
    const k = Number(step);
    const maxStep = spec.name === '연도' ? 1000 : spec.max;
    if (k < 1 || k > maxStep) {
      fail('RANGE', spec.name, `${spec.name} 증가값은 1~${maxStep} 사이여야 합니다: ${raw}`);
    }
  }
  if (base === '*') return;
  const parts = base.split('-');
  if (parts.length > 2 || parts.some((p) => p === '')) {
    fail('SYNTAX', spec.name, `${spec.name} 범위 문법이 올바르지 않습니다: ${raw}`);
  }
  // 이름에 증가값을 붙이면 Quartz 2.3.2는 증가값을 무시한다
  const allowName = step === undefined;
  const from = value(spec, parts[0]!, allowName);
  if (parts.length === 2) {
    const to = value(spec, parts[1]!, allowName);
    if (spec.name === '연도' && to < from) {
      fail('RANGE', spec.name, `연도 범위는 시작이 끝보다 작아야 합니다: ${raw}`);
    }
  }
}

function list(spec: FieldSpec, field: string): void {
  for (const raw of field.split(',')) {
    if (raw === '') fail('SYNTAX', spec.name, `${spec.name} 필드에 빈 항목이 있습니다: ${field}`);
    if (raw === '?' || raw.includes('#')) {
      fail('SYNTAX', spec.name, `'${raw}'는 ${spec.name} 필드의 목록 안에 쓸 수 없습니다`);
    }
    item(spec, raw);
  }
}

function dayOfMonth(field: string): void {
  const spec = SPECS[3]!;
  if (field === '?' || field === 'L' || field === 'LW') return;
  let m = /^L-(\d+)(W?)$/.exec(field);
  if (m) {
    if (Number(m[1]) > 30) fail('RANGE', '일', `말일 기준 오프셋은 30 이하여야 합니다: ${field}`);
    return;
  }
  m = /^(\d+)W$/.exec(field);
  if (m) {
    const d = Number(m[1]);
    if (d < 1 || d > 31) fail('RANGE', '일', `일 값은 1~31 사이여야 합니다: ${field}`);
    if (d > 28) {
      fail(
        'UNSUPPORTED',
        '일',
        `29일 이후의 'W'는 지원하지 않습니다(그 날이 없는 달에서 Quartz 버전마다 결과가 다름): ${field}`,
      );
    }
    return;
  }
  if (field.includes('W') && field.includes(',')) {
    fail('UNSUPPORTED', '일', `'W'는 다른 날짜와 함께 쓸 수 없습니다: ${field}`);
  }
  if (field.includes('L') && field.includes(',')) {
    fail('SYNTAX', '일', `'L'은 다른 날짜와 함께 쓸 수 없습니다: ${field}`);
  }
  list(spec, field);
}

function dayOfWeek(field: string): void {
  const spec = SPECS[5]!;
  if (field === '?' || field === 'L') return;
  let m = /^([^#L]+)L$/.exec(field);
  if (m) {
    value(spec, m[1]!, true);
    return;
  }
  m = /^([^#L]+)#(\d+)$/.exec(field);
  if (m) {
    value(spec, m[1]!, true);
    const n = Number(m[2]);
    if (n < 1 || n > 5) fail('RANGE', '요일', `'#' 다음 숫자는 1~5여야 합니다: ${field}`);
    return;
  }
  if (field.includes('L') && field.includes(',')) {
    fail('SYNTAX', '요일', `'L'은 다른 요일과 함께 쓸 수 없습니다: ${field}`);
  }
  if (field.includes('#')) fail('SYNTAX', '요일', `'#'은 요일 하나에만 쓸 수 있습니다: ${field}`);
  list(spec, field);
}

function check(expression: string): string[] {
  const fields = expression.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (fields.length === 0) fail('SYNTAX', undefined, 'cron 표현식을 입력하세요');
  if (fields.length < 6 || fields.length > 7) {
    fail(
      'SYNTAX',
      undefined,
      `cron 표현식은 필드 6개(초 분 시 일 월 요일) 또는 7개(연도 포함)여야 합니다. 지금은 ${fields.length}개입니다`,
    );
  }
  const [sec, min, hour, dom, month, dow, year] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  list(SPECS[0]!, sec);
  list(SPECS[1]!, min);
  list(SPECS[2]!, hour);
  dayOfMonth(dom);
  list(SPECS[4]!, month);
  dayOfWeek(dow);
  if (year !== undefined) list(SPECS[6]!, year);
  if ((dom === '?') === (dow === '?')) {
    fail(
      'SYNTAX',
      dom === '?' ? '일' : '요일',
      "일과 요일 중 정확히 하나는 '?'여야 합니다(예: 매일 '0 0 12 * * ?', 평일 '0 0 12 ? * MON-FRI')",
    );
  }
  return fields;
}

/** cron 표현식을 검증한다. 통과하면 Quartz 이식본으로 계산할 수 있다 */
export function validateCron(expression: string): CronValidation {
  let fields: string[];
  try {
    fields = check(expression);
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.error };
    throw e;
  }
  const normalized = fields.join(' ');
  try {
    const parsed = new QuartzCronExpression(normalized);
    for (const set of [parsed.seconds, parsed.minutes, parsed.hours, parsed.months, parsed.years]) {
      if (set.isEmpty()) {
        return {
          ok: false,
          error: {
            code: 'QUARTZ',
            message: 'Quartz가 이 표현식으로 실행 시각을 계산할 수 없습니다',
          },
        };
      }
    }
    return { ok: true, expression: normalized, parsed };
  } catch (e) {
    if (e instanceof QuartzParseError) {
      return {
        ok: false,
        error: {
          code: 'QUARTZ',
          message: `Quartz가 이 표현식을 거부합니다: ${e.message}`,
          quartzMessage: e.message,
        },
      };
    }
    throw e;
  }
}

/** @throws CronValidationError */
export function parseCron(expression: string): QuartzCronExpression {
  const result = validateCron(expression);
  if (!result.ok) throw new CronValidationError(result.error);
  return result.parsed;
}
