import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { API_PREFIX, APP_NAME } from '@qa/shared';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module.js';
import { InstanceLock, InstanceLockError } from './meta-db/instance-lock.js';
import { metaDbPath } from './meta-db/meta-db.js';
import { resolveMetaDbOptions } from './meta-db/tokens.js';

/**
 * Nest 초기화 전에 다른 인스턴스가 있는지 먼저 본다.
 * 초기화 중에 실패하면 Nest가 스택 트레이스를 함께 찍어 원인이 묻히기 때문이다.
 * 실제 락 확보는 MetaDbService가 한다.
 */
function assertSingleInstance(): void {
  const file = metaDbPath(resolveMetaDbOptions().dataDir);
  if (!existsSync(file)) return;
  const sqlite = new Database(file, { fileMustExist: true });
  try {
    new InstanceLock(sqlite).check();
  } finally {
    sqlite.close();
  }
}

try {
  assertSingleInstance();
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`${APP_NAME} API listening on :${port}/${API_PREFIX}`, 'Bootstrap');
} catch (err) {
  if (err instanceof InstanceLockError) {
    Logger.error(err.message, 'Bootstrap');
  } else {
    Logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err), 'Bootstrap');
  }
  process.exitCode = 1;
}
