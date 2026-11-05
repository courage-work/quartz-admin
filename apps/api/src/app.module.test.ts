import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { metaDbPath } from './meta-db/meta-db.js';
import { MetaDbService } from './meta-db/meta-db.service.js';
import { tempDataDir } from './meta-db/test-support.js';

describe('AppModule', () => {
  let tmp: ReturnType<typeof tempDataDir>;
  beforeEach(() => {
    tmp = tempDataDir();
    process.env.QA_DATA_DIR = tmp.dir;
  });
  afterEach(() => {
    delete process.env.QA_DATA_DIR;
    tmp.cleanup();
  });

  it('QA_DATA_DIR에 메타데이터 저장소를 만들고, 종료하면 락을 해제한다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    expect(existsSync(metaDbPath(tmp.dir))).toBe(true);
    const sqlite = app.get(MetaDbService).sqlite;
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM instance_lock').get()).toEqual({ n: 1 });

    await app.close();
    expect(sqlite.open).toBe(false);
  });
});
