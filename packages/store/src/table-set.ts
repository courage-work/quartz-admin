import type { QuartzDialect } from './dialect.js';
import { QUARTZ_REQUIRED_TABLES, isQuartzTableKey, type QuartzTableKey } from './quartz-tables.js';

/**
 * 스케줄러 하나가 쓰는 Quartz 테이블의 실제 이름 (TRD §4.4, §5.5).
 * 자동 감지가 카탈로그에서 확인한 이름(`schedulers.table_names_json`)만 받는다.
 */
export interface TableNames {
  /** 테이블 소유 스키마(Oracle OWNER, PostgreSQL schema). MySQL·MariaDB는 접속한 DB를 쓰므로 비운다 */
  schema?: string | undefined;
  /** 논리 이름(prefix 제외, 대문자) → 카탈로그의 실제 테이블 이름 */
  tables: Partial<Record<QuartzTableKey, string>>;
}

/** SQL에 넣을 테이블 식별자를 만든다. 항상 따옴표로 감싸고 스키마를 붙인다 */
export interface TableSet {
  /** 따옴표로 감싼 `"SCHEMA"."QRTZ_TRIGGERS"` 형태. 없는 선택 테이블이면 던진다 */
  table(key: QuartzTableKey): string;
  /** 선택 테이블(SIMPROP_TRIGGERS)이 있는지 */
  has(key: QuartzTableKey): boolean;
  /** 감지한 실제 이름 */
  readonly names: Readonly<TableNames>;
}

/** 식별자 문자열 검사. 따옴표로 감싸도 깨지지 않는 값만 허용한다 */
function isSafeIdent(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !/["`]/.test(value) && !value.includes('\0');
}

export function createTableSet(dialect: QuartzDialect, names: TableNames): TableSet {
  if (names.schema !== undefined && !isSafeIdent(names.schema)) {
    throw new Error('스키마 이름으로 쓸 수 없는 값입니다');
  }
  for (const [key, value] of Object.entries(names.tables)) {
    if (!isQuartzTableKey(key)) {
      throw new Error(`알 수 없는 Quartz 테이블입니다: ${key}`);
    }
    if (typeof value !== 'string' || !isSafeIdent(value)) {
      throw new Error(`${key} 테이블 이름으로 쓸 수 없는 값입니다`);
    }
  }
  const missing = QUARTZ_REQUIRED_TABLES.filter((key) => names.tables[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`필수 Quartz 테이블이 없습니다: ${missing.join(', ')}`);
  }

  const schemaPrefix = names.schema === undefined ? '' : `${dialect.quote(names.schema)}.`;
  const quoted = new Map<QuartzTableKey, string>();
  for (const [key, value] of Object.entries(names.tables) as [QuartzTableKey, string][]) {
    quoted.set(key, schemaPrefix + dialect.quote(value));
  }
  const frozen: TableNames = Object.freeze({
    schema: names.schema,
    tables: Object.freeze({ ...names.tables }),
  });

  return {
    names: frozen,
    has: (key) => quoted.has(key),
    table(key) {
      const value = quoted.get(key);
      if (value === undefined) {
        throw new Error(`이 스케줄러에는 ${key} 테이블이 없습니다`);
      }
      return value;
    },
  };
}
