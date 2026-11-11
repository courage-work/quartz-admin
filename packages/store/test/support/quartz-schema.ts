import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_DB, type TestDbKind } from './db.js';
import { TESTBED_DIR } from './paths.js';

/** Quartz 2.x JDBC JobStore 테이블(prefix 제외, 대문자). FK 순서상 부모가 앞이다. */
export const QUARTZ_TABLES = [
  'JOB_DETAILS',
  'TRIGGERS',
  'SIMPLE_TRIGGERS',
  'CRON_TRIGGERS',
  'SIMPROP_TRIGGERS',
  'BLOB_TRIGGERS',
  'CALENDARS',
  'PAUSED_TRIGGER_GRPS',
  'FIRED_TRIGGERS',
  'SCHEDULER_STATE',
  'LOCKS',
] as const;

export type QuartzTable = (typeof QUARTZ_TABLES)[number];

/**
 * Quartz 배포본의 스키마 파일. `oracle`은 `tables_oracle.sql`(2.3.2와 2.5.x 공통, 불리언은 VARCHAR2(1)),
 * `oracle23`은 2.5.x에 추가된 `tables_oracle23.sql`(불리언 컬럼이 Oracle 23 BOOLEAN)이다.
 * `postgres`는 `tables_postgres.sql`(2.3.2와 2.5.x가 같음, 불리언은 BOOL, BLOB은 BYTEA, 이름은 따옴표 없음)이다.
 * `mysql`은 `tables_mysql_innodb.sql`(2.3.2와 2.5.x가 같음, 불리언은 VARCHAR(1), BLOB, 이름은 대문자)이다.
 */
export type QuartzSchemaVariant = 'oracle' | 'oracle23' | 'postgres' | 'mysql';

const SCHEMA_FILES: Record<QuartzSchemaVariant, string> = {
  oracle: 'tables_oracle.sql',
  oracle23: 'tables_oracle23.sql',
  postgres: 'tables_postgres.sql',
  mysql: 'tables_mysql_innodb.sql',
};

/**
 * 테이블명 대소문자. `upper`는 따옴표 없는 식별자(Oracle은 대문자로, PostgreSQL은 소문자로 저장), `lower`는 따옴표로
 * 감싼 소문자 이름이다. Quartz는 테이블명을 따옴표 없이 쓰므로 Oracle의 `lower` 스키마에는 Quartz 노드를 붙일 수 없다(자동 감지 테스트용).
 */
export type TableCase = 'upper' | 'lower';

export interface QuartzSchemaOptions {
  /** 기본 `QRTZ_` */
  prefix?: string;
  /** 기본 `upper` */
  tableCase?: TableCase;
  /** 기본은 DB에 맞춰 `oracle` 또는 `postgres` */
  variant?: QuartzSchemaVariant;
  /** 기본 {@link TEST_DB} */
  db?: TestDbKind;
}

/** 쿼리 하나를 실행할 수 있는 연결. oracledb `Connection`이 그대로 맞는다. */
export interface SqlExecutor {
  execute(sql: string): Promise<unknown>;
}

const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_$#]*$/;
const TABLE_SET = new Set<string>(QUARTZ_TABLES);

function resolve(options: QuartzSchemaOptions): Required<QuartzSchemaOptions> {
  const prefix = options.prefix ?? 'QRTZ_';
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(`테이블 prefix로 쓸 수 없는 값입니다: ${prefix}`);
  }
  const db = options.db ?? TEST_DB;
  return {
    prefix,
    tableCase: options.tableCase ?? 'upper',
    variant: options.variant ?? (db === 'oracle' ? 'oracle' : db),
    db,
  };
}

/** SQL에 그대로 넣을 수 있는 테이블 식별자. `lower`이면 따옴표로 감싼다. */
export function quartzTableName(table: QuartzTable, options: QuartzSchemaOptions = {}): string {
  const { prefix, tableCase } = resolve(options);
  const name = `${prefix}${table}`;
  return tableCase === 'lower' ? `"${name.toLowerCase()}"` : name.toUpperCase();
}

/** 카탈로그(Oracle ALL_TABLES, PostgreSQL information_schema)에 보이는 실제 테이블 이름 */
export function quartzCatalogName(table: QuartzTable, options: QuartzSchemaOptions = {}): string {
  const { prefix, tableCase, db } = resolve(options);
  const name = `${prefix}${table}`;
  // 따옴표 없는 이름은 Oracle이 대문자로, PostgreSQL이 소문자로 저장한다
  return tableCase === 'lower' || db === 'postgres' ? name.toLowerCase() : name.toUpperCase();
}

/** 제품 `createTableSet`에 넘기는 논리 이름 → 실제 이름. SIMPROP까지 모두 넣는다 */
export function quartzCatalogNames(
  options: QuartzSchemaOptions = {},
): Partial<Record<QuartzTable, string>> {
  return Object.fromEntries(QUARTZ_TABLES.map((t) => [t, quartzCatalogName(t, options)]));
}

export function readQuartzSchemaSql(variant: QuartzSchemaVariant = 'oracle'): string {
  return readFileSync(join(TESTBED_DIR, 'schema', SCHEMA_FILES[variant]), 'utf8');
}

/**
 * Quartz 스키마 파일에서 CREATE 문만 뽑아 prefix와 대소문자를 바꾼다.
 *
 * - 원본 앞부분의 `delete from`, `drop table`은 버린다(빈 스키마에서는 실패하므로).
 * - 테이블 이름뿐 아니라 제약 조건(`QRTZ_..._PK`)과 인덱스(`idx_qrtz_...`) 이름의 `qrtz_`도 prefix로 바꾼다.
 *   Oracle에서 이 이름들은 스키마 안에서 유일해야 하므로, 이렇게 해야 한 스키마에 prefix 두 개를 둘 수 있다.
 */
export function quartzSchemaStatements(sql: string, options: QuartzSchemaOptions = {}): string[] {
  const { prefix } = resolve(options);
  const upperPrefix = prefix.toUpperCase();
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^create\s/i.test(s))
    .map((s) =>
      s.replace(/\b(idx_)?qrtz_(\w+)/gi, (_match, idx: string | undefined, rest: string) => {
        const suffix = rest.toUpperCase();
        if (idx) {
          return `IDX_${upperPrefix}${suffix}`;
        }
        if (TABLE_SET.has(suffix)) {
          return quartzTableName(suffix as QuartzTable, options);
        }
        return `${upperPrefix}${suffix}`;
      }),
    );
}

/** 자식 테이블부터 지우는 DROP 문 */
export function quartzDropStatements(options: QuartzSchemaOptions = {}): string[] {
  const order: QuartzTable[] = [
    'FIRED_TRIGGERS',
    'SIMPLE_TRIGGERS',
    'CRON_TRIGGERS',
    'SIMPROP_TRIGGERS',
    'BLOB_TRIGGERS',
    'TRIGGERS',
    'JOB_DETAILS',
    'CALENDARS',
    'PAUSED_TRIGGER_GRPS',
    'LOCKS',
    'SCHEDULER_STATE',
  ];
  const { db } = resolve(options);
  return order.map((t) =>
    db === 'oracle'
      ? `DROP TABLE ${quartzTableName(t, options)} PURGE`
      : `DROP TABLE IF EXISTS ${quartzTableName(t, options)}`,
  );
}

/** Quartz 스키마를 만든다. 이미 같은 이름의 테이블이 있으면 실패한다. */
export async function initQuartzSchema(
  db: SqlExecutor,
  options: QuartzSchemaOptions = {},
): Promise<void> {
  const { variant } = resolve(options);
  for (const statement of quartzSchemaStatements(readQuartzSchemaSql(variant), options)) {
    await db.execute(statement);
  }
}

/** Quartz 스키마를 지운다. 없는 테이블은 건너뛴다. */
export async function dropQuartzSchema(
  db: SqlExecutor,
  options: QuartzSchemaOptions = {},
): Promise<void> {
  for (const statement of quartzDropStatements(options)) {
    try {
      await db.execute(statement);
    } catch (error) {
      // ORA-00942: 테이블이 없음
      if (!(error instanceof Error && error.message.includes('ORA-00942'))) {
        throw error;
      }
    }
  }
}
