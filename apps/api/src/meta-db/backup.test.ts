import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDir, backupFileName, createBackup, pruneBackups } from './backup.js';
import { createMetaDb, metaDbPath, openSqlite, runMigrations } from './meta-db.js';
import { settings } from './schema.js';
import { tempDataDir } from './test-support.js';

describe('백업', () => {
  let src: ReturnType<typeof tempDataDir>;
  let restore: ReturnType<typeof tempDataDir>;
  beforeEach(() => {
    src = tempDataDir();
    restore = tempDataDir();
  });
  afterEach(() => {
    src.cleanup();
    restore.cleanup();
  });

  it('파일명은 UTC 시각을 담고 이름순이 시간순이다', () => {
    expect(backupFileName(new Date('2026-11-05T03:00:07.123Z'))).toBe(
      'quartz-admin-20261105T030007Z.db',
    );
  });

  it('운영 중인 DB를 백업하고, 백업 파일로 복원해 다시 열 수 있다', async () => {
    const sqlite = openSqlite(src.dir);
    const db = createMetaDb(sqlite);
    runMigrations(db);
    db.insert(settings).values({ key: 'probe', value: 'before-backup', updatedAt: 1 }).run();

    const file = await createBackup(sqlite, backupDir(src.dir), new Date('2026-11-05T03:00:00Z'));
    // 백업 이후의 변경은 백업에 들어가지 않는다
    db.insert(settings).values({ key: 'after', value: 'x', updatedAt: 2 }).run();
    sqlite.close();

    // Windows는 POSIX 권한이 없다. CI(Linux)에서 확인한다
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    // 복원: 백업 파일을 새 데이터 디렉터리의 DB 파일로 복사한 뒤 기동 절차대로 연다
    copyFileSync(file, metaDbPath(restore.dir));
    const restored = openSqlite(restore.dir);
    const restoredDb = createMetaDb(restored);
    expect(() => runMigrations(restoredDb)).not.toThrow();
    expect(
      restoredDb
        .select()
        .from(settings)
        .all()
        .map((r) => r.key),
    ).toEqual(['probe']);
    restored.close();
  });

  it('최신 7개만 남기고 이름 규칙이 다른 파일은 건드리지 않는다', () => {
    const dir = backupDir(src.dir);
    mkdirSync(dir, { recursive: true });
    for (let day = 1; day <= 9; day++) {
      writeFileSync(join(dir, backupFileName(new Date(Date.UTC(2026, 10, day, 3)))), '');
    }
    writeFileSync(join(dir, 'manual-copy.db'), '');

    expect(pruneBackups(dir, 7)).toEqual([
      'quartz-admin-20261102T030000Z.db',
      'quartz-admin-20261101T030000Z.db',
    ]);
    const left = readdirSync(dir);
    expect(left).toHaveLength(8);
    expect(left).toContain('manual-copy.db');
    expect(left).toContain('quartz-admin-20261109T030000Z.db');
  });

  it('백업 디렉터리가 없으면 아무것도 지우지 않는다', () => {
    expect(pruneBackups(join(src.dir, 'missing'))).toEqual([]);
  });
});
