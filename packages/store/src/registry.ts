import type { DriverAdapter } from './adapter.js';
import type { DbKind } from './db-kind.js';
import type { QuartzDialect } from './dialect.js';
import { MariadbAdapter, MysqlAdapter } from './mysql/adapter.js';
import { mariadbDialect, mysqlDialect } from './mysql/dialect.js';
import { OracleAdapter } from './oracle/adapter.js';
import { oracleDialect } from './oracle/dialect.js';
import { PostgresAdapter } from './postgres/adapter.js';
import { postgresDialect } from './postgres/dialect.js';

/** 지원하는 드라이버 어댑터 (TRD §5.1) */
export function createDriverAdapters(): DriverAdapter[] {
  return [new OracleAdapter(), new PostgresAdapter(), new MysqlAdapter(), new MariadbAdapter()];
}

const DIALECTS: Partial<Record<DbKind, QuartzDialect>> = {
  oracle: oracleDialect,
  postgresql: postgresDialect,
  mysql: mysqlDialect,
  mariadb: mariadbDialect,
};

/** DB 종류의 `QuartzDialect`. 아직 없는 종류면 `undefined` */
export function dialectFor(kind: DbKind): QuartzDialect | undefined {
  return DIALECTS[kind];
}
