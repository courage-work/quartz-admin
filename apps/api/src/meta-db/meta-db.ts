import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type MetaDb = BetterSQLite3Database<typeof schema>;
export type Sqlite = Database.Database;

export const META_DB_FILE = 'quartz-admin.db';

/** src/meta-db와 dist/meta-db 모두에서 apps/api/drizzle을 가리킨다 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function metaDbPath(dataDir: string): string {
  return join(dataDir, META_DB_FILE);
}

/** 데이터 디렉터리를 만들고 SQLite 파일을 연다 (TRD §3.1, NFR-SEC-05) */
export function openSqlite(dataDir: string): Sqlite {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = metaDbPath(dataDir);
  const sqlite = new Database(file);
  applyPragmas(sqlite);
  chmodSync(file, 0o600);
  return sqlite;
}

export function applyPragmas(sqlite: Sqlite): void {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
}

export function createMetaDb(sqlite: Sqlite): MetaDb {
  return drizzle(sqlite, { schema, casing: 'snake_case' });
}

/** 적용되지 않은 마이그레이션만 순서대로 적용한다 (NFR-OPS-04) */
export function runMigrations(db: MetaDb, migrationsFolder: string = MIGRATIONS_DIR): void {
  migrate(db, { migrationsFolder });
}
