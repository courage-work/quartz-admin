import type { DriverAdapter } from './adapter.js';
import type { DbKind } from './db-kind.js';
import type { QuartzDialect } from './dialect.js';
import { OracleAdapter } from './oracle/adapter.js';
import { oracleDialect } from './oracle/dialect.js';

/** 지금 지원하는 드라이버 어댑터. PostgreSQL, MySQL, MariaDB는 B-27~B-29에서 추가한다 */
export function createDriverAdapters(): DriverAdapter[] {
  return [new OracleAdapter()];
}

const DIALECTS: Partial<Record<DbKind, QuartzDialect>> = { oracle: oracleDialect };

/** DB 종류의 `QuartzDialect`. 아직 없는 종류면 `undefined` */
export function dialectFor(kind: DbKind): QuartzDialect | undefined {
  return DIALECTS[kind];
}
