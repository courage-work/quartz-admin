import type { BoolFormat, BoolFormatSource, DetectionWarning } from './types.js';

/** BOOLEAN 컬럼 타입 이름(대문자). Oracle 23 `BOOLEAN`, PostgreSQL `boolean`/`bool` */
const NATIVE_BOOL_TYPES = new Set(['BOOLEAN', 'BOOL']);

const VALUE_FORMATS: Record<string, Exclude<BoolFormat, 'native'>> = {
  '1': '10',
  '0': '10',
  Y: 'YN',
  N: 'YN',
  T: 'TF',
  F: 'TF',
  TRUE: 'TF',
  FALSE: 'TF',
};

export interface BoolFormatResult {
  format: BoolFormat;
  source: BoolFormatSource;
  warnings: DetectionWarning[];
}

/**
 * 불리언 저장 형식 판정 (TRD §5.5 4단계).
 *
 * - 컬럼 타입이 BOOLEAN이면 `native`
 * - 문자·숫자 타입이면 JOB_DETAILS 불리언 컬럼의 DISTINCT 값으로 `10`/`YN`/`TF` 중 하나를 고른다
 * - 값이 하나도 없으면(잡이 없음) `10`. Quartz는 `setBoolean`으로 저장하므로 문자 컬럼에는 `'1'`/`'0'`이 들어간다
 */
export function decideBoolFormat(
  dataType: string | undefined,
  distinctValues: readonly unknown[],
): BoolFormatResult {
  if (dataType !== undefined && NATIVE_BOOL_TYPES.has(dataType.toUpperCase())) {
    return { format: 'native', source: 'column-type', warnings: [] };
  }
  const warnings: DetectionWarning[] = [];
  const counts = new Map<Exclude<BoolFormat, 'native'>, number>();
  for (const value of distinctValues) {
    if (value === null || value === undefined) continue;
    const key =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
        ? String(value).trim().toUpperCase()
        : undefined;
    const format = key === undefined ? undefined : VALUE_FORMATS[key];
    if (format === undefined) {
      if (!warnings.includes('BOOL_FORMAT_UNKNOWN_VALUE'))
        warnings.push('BOOL_FORMAT_UNKNOWN_VALUE');
      continue;
    }
    counts.set(format, (counts.get(format) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return { format: '10', source: 'default', warnings };
  }
  if (counts.size > 1) warnings.push('BOOL_FORMAT_MIXED');
  const [format] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { format, source: 'values', warnings };
}
