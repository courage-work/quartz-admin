import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceService, msUntilNextRun } from './maintenance.service.js';
import { MetaDbService } from './meta-db.service.js';
import { tempDataDir } from './test-support.js';
import type { MetaDbOptions } from './tokens.js';

describe('msUntilNextRun', () => {
  it('오늘 실행 시각 전이면 오늘, 지났으면 내일로 잡는다', () => {
    const before = new Date(2026, 10, 5, 1, 30);
    expect(msUntilNextRun(before, 3)).toBe(90 * 60_000);

    const after = new Date(2026, 10, 5, 3, 0, 0, 1);
    const next = new Date(after.getTime() + msUntilNextRun(after, 3));
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([6, 3, 0]);
  });
});

describe('MaintenanceService', () => {
  let tmp: ReturnType<typeof tempDataDir>;
  let metaDb: MetaDbService;
  let service: MaintenanceService;

  beforeEach(() => {
    tmp = tempDataDir();
    const options: MetaDbOptions = { dataDir: tmp.dir, maintenanceHour: 3 };
    metaDb = new MetaDbService(options);
    service = new MaintenanceService(metaDb, options);
  });
  afterEach(() => {
    metaDb.onApplicationShutdown();
    tmp.cleanup();
  });

  it('백업을 만들고 등록된 보존 작업을 모두 실행하며, 한 작업의 실패가 다른 작업을 막지 않는다', async () => {
    const calls: string[] = [];
    service.register({
      name: 'broken',
      run: () => {
        throw new Error('boom');
      },
    });
    service.register({
      name: 'sessions',
      run: (now) => {
        calls.push(`sessions@${now}`);
        return 3;
      },
    });

    const at = new Date('2026-11-05T03:00:00Z');
    const report = await service.runOnce(at);

    expect(report.backupFile && existsSync(report.backupFile)).toBe(true);
    expect(report.tasks).toEqual([
      { name: 'broken', error: 'boom' },
      { name: 'sessions', removed: 3 },
    ]);
    expect(calls).toEqual([`sessions@${at.getTime()}`]);
  });
});
