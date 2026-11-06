import {
  QUARTZ_OPTIONAL_TABLES,
  QUARTZ_REQUIRED_TABLES,
  QUARTZ_TABLE_KEYS,
  type QuartzTableKey,
} from '../quartz-tables.js';
import type { QuartzFeatures, UnusableTableSet } from './types.js';

/** 카탈로그에서 읽은 컬럼 하나 */
export interface CatalogColumn {
  table: string;
  column: string;
  dataType: string;
}

/** prefix 하나에 대한 테이블 매칭 결과 */
export interface MatchedTableSet {
  prefix: string;
  tableNames: Partial<Record<QuartzTableKey, string>>;
}

const TRIGGERS = 'TRIGGERS';

/**
 * 테이블 목록에서 Quartz 테이블 세트를 찾는다 (TRD §5.5 1~2단계).
 *
 * 1. 대문자로 바꿨을 때 `TRIGGERS`로 끝나는 테이블마다 그 앞부분을 prefix 후보로 둔다.
 *    `QRTZ_SIMPLE_TRIGGERS`에서 나온 `QRTZ_SIMPLE_` 같은 후보를 버리려고 `<prefix>JOB_DETAILS`도 있는 후보만 남긴다.
 * 2. 후보마다 필수 테이블을 찾는다. 먼저 `TRIGGERS` 테이블과 같은 대소문자(전부 대문자 또는 전부 소문자)로 찾고,
 *    없으면 대소문자를 무시하고 하나뿐인 이름을 쓴다. 같은 스키마에 `QRTZ_`와 `qrtz_`(따옴표 소문자) 세트가
 *    함께 있어도 서로 섞이지 않는다.
 */
export function matchTableSets(tableNames: readonly string[]): {
  matched: MatchedTableSet[];
  unusable: UnusableTableSet[];
} {
  const exact = new Set(tableNames);
  const byUpper = new Map<string, string[]>();
  for (const name of tableNames) {
    const upper = name.toUpperCase();
    byUpper.set(upper, [...(byUpper.get(upper) ?? []), name]);
  }

  const matched: MatchedTableSet[] = [];
  const unusable: UnusableTableSet[] = [];
  const seen = new Set<string>();

  for (const name of [...tableNames].sort()) {
    const upper = name.toUpperCase();
    if (!upper.endsWith(TRIGGERS)) continue;
    const prefix = name.slice(0, name.length - TRIGGERS.length);
    if (seen.has(prefix)) continue;
    seen.add(prefix);

    const suffix = name.slice(prefix.length);
    const caseOf =
      suffix === TRIGGERS ? 'upper' : suffix === TRIGGERS.toLowerCase() ? 'lower' : 'mixed';
    const find = (key: QuartzTableKey): string | undefined => {
      if (caseOf !== 'mixed') {
        const candidate = prefix + (caseOf === 'upper' ? key : key.toLowerCase());
        if (exact.has(candidate)) return candidate;
      }
      const loose = byUpper.get((prefix + key).toUpperCase()) ?? [];
      return loose.length === 1 ? loose[0] : undefined;
    };

    if (find('JOB_DETAILS') === undefined) continue;

    const names: Partial<Record<QuartzTableKey, string>> = { TRIGGERS: name };
    for (const key of QUARTZ_TABLE_KEYS) {
      const found = find(key);
      if (found !== undefined) names[key] = found;
    }
    const missing = QUARTZ_REQUIRED_TABLES.filter((key) => names[key] === undefined);
    if (missing.length > 0) {
      unusable.push({ prefix, reason: 'MISSING_TABLES', tables: missing });
    } else {
      matched.push({ prefix, tableNames: names });
    }
  }
  return { matched, unusable };
}

/** SCHED_NAME 컬럼이 있어야 하는 테이블. 없으면 Quartz 1.x 스키마라 지원하지 않는다 */
const SCHED_NAME_TABLES: readonly QuartzTableKey[] = [
  'JOB_DETAILS',
  'TRIGGERS',
  'SCHEDULER_STATE',
  'LOCKS',
];

/** 테이블별 컬럼 이름(대문자) */
export type ColumnIndex = Map<string, Map<string, string>>;

export function indexColumns(columns: readonly CatalogColumn[]): ColumnIndex {
  const index: ColumnIndex = new Map();
  for (const c of columns) {
    let table = index.get(c.table);
    if (!table) index.set(c.table, (table = new Map<string, string>()));
    table.set(c.column.toUpperCase(), c.dataType);
  }
  return index;
}

/** SCHED_NAME 컬럼이 빠진 테이블 */
export function tablesWithoutSchedName(
  set: MatchedTableSet,
  columns: ColumnIndex,
): QuartzTableKey[] {
  return SCHED_NAME_TABLES.filter((key) => {
    const table = set.tableNames[key];
    return table === undefined || !columns.get(table)?.has('SCHED_NAME');
  });
}

/** 선택 테이블·컬럼 존재 여부 (TRD §5.5 3단계) */
export function detectFeatures(set: MatchedTableSet, columns: ColumnIndex): QuartzFeatures {
  const has = (key: QuartzTableKey, column: string): boolean => {
    const table = set.tableNames[key];
    return table !== undefined && (columns.get(table)?.has(column) ?? false);
  };
  return {
    simpropTriggers: QUARTZ_OPTIONAL_TABLES.every((key) => set.tableNames[key] !== undefined),
    triggerPriority: has('TRIGGERS', 'PRIORITY'),
    firedPriority: has('FIRED_TRIGGERS', 'PRIORITY'),
    firedSchedTime: has('FIRED_TRIGGERS', 'SCHED_TIME'),
    jobNonconcurrent: has('JOB_DETAILS', 'IS_NONCONCURRENT'),
    jobUpdateData: has('JOB_DETAILS', 'IS_UPDATE_DATA'),
    cronTimeZone: has('CRON_TRIGGERS', 'TIME_ZONE_ID'),
  };
}

/** 컬럼의 데이터 타입. 없으면 `undefined` */
export function columnType(
  set: MatchedTableSet,
  columns: ColumnIndex,
  key: QuartzTableKey,
  column: string,
): string | undefined {
  const table = set.tableNames[key];
  return table === undefined ? undefined : columns.get(table)?.get(column);
}
