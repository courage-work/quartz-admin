/** SQLite 온라인 백업 (TRD §3.1, PRD NFR-REL-03) */
import type Database from 'better-sqlite3';
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BACKUP_DIR_NAME = 'backups';
export const BACKUP_KEEP = 7;

const BACKUP_FILE_RE = /^quartz-admin-\d{8}T\d{6}Z\.db$/;

/** `quartz-admin-20261105T030000Z.db` (UTC, 이름순 정렬 = 시간순) */
export function backupFileName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `quartz-admin-${stamp}.db`;
}

export function backupDir(dataDir: string): string {
  return join(dataDir, BACKUP_DIR_NAME);
}

/** 운영 중인 DB를 잠그지 않고 target 파일로 복사한다 */
export async function backupTo(sqlite: Database.Database, target: string): Promise<string> {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  await sqlite.backup(target);
  chmodSync(target, 0o600);
  return target;
}

export async function createBackup(
  sqlite: Database.Database,
  dir: string,
  at: Date = new Date(),
): Promise<string> {
  return backupTo(sqlite, join(dir, backupFileName(at)));
}

/** 최신 keep개만 남기고 오래된 백업을 지운다. 이름 규칙이 다른 파일은 건드리지 않는다 */
export function pruneBackups(dir: string, keep: number = BACKUP_KEEP): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const backups = names
    .filter((n) => BACKUP_FILE_RE.test(n))
    .sort()
    .reverse();
  const removed = backups.slice(keep);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}
