import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { testConfig } from './config/test-support.js';
import { SecretBox, secretAad } from './crypto/secret-box.js';
import { metaDbPath } from './meta-db/meta-db.js';
import { MetaDbService } from './meta-db/meta-db.service.js';
import { tempDataDir } from './meta-db/test-support.js';

describe('AppModule', () => {
  let tmp: ReturnType<typeof tempDataDir>;
  beforeEach(() => {
    tmp = tempDataDir();
  });
  afterEach(() => tmp.cleanup());

  it('설정의 데이터 디렉터리에 저장소를 만들고, 암호화 서비스를 제공하며, 종료하면 락을 해제한다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(testConfig({ dataDir: tmp.dir }))],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    expect(existsSync(metaDbPath(tmp.dir))).toBe(true);
    const sqlite = app.get(MetaDbService).sqlite;
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM instance_lock').get()).toEqual({ n: 1 });

    const box = app.get(SecretBox);
    const aad = secretAad('connections', 1);
    expect(box.decrypt(box.encrypt('pw', aad), aad)).toBe('pw');

    await app.close();
    expect(sqlite.open).toBe(false);
  });
});
