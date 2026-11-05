/**
 * 운영 CLI: `node dist/cli.js <command>`
 *
 *   backup [--out <file>]   메타데이터 저장소를 온라인 백업 (기본: $QA_DATA_DIR/backups/)
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { backupDir, backupTo, createBackup, pruneBackups } from './meta-db/backup.js';
import { metaDbPath } from './meta-db/meta-db.js';
import { resolveMetaDbOptions } from './meta-db/tokens.js';

const USAGE = `사용법: node dist/cli.js <command>

  backup [--out <file>]   메타데이터 저장소를 온라인 백업합니다 (기본 위치: $QA_DATA_DIR/backups/)`;

async function backup(args: string[]): Promise<void> {
  const { dataDir } = resolveMetaDbOptions();
  const file = metaDbPath(dataDir);
  if (!existsSync(file)) {
    throw new Error(`메타데이터 파일이 없습니다: ${file} (QA_DATA_DIR를 확인하세요)`);
  }
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outIndex >= 0 && !out) throw new Error('--out 다음에 파일 경로가 필요합니다');

  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (out) {
      console.log(await backupTo(sqlite, out));
    } else {
      const dir = backupDir(dataDir);
      console.log(await createBackup(sqlite, dir));
      pruneBackups(dir);
    }
  } finally {
    sqlite.close();
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'backup':
      await backup(args);
      break;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
