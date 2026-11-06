import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX, APP_NAME } from '@qa/shared';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ConfigError, loadConfig } from './config/env.js';
import { InstanceLock, InstanceLockError } from './meta-db/instance-lock.js';
import { metaDbPath } from './meta-db/meta-db.js';

/**
 * Nest 초기화 전에 다른 인스턴스가 있는지 먼저 본다.
 * 초기화 중에 실패하면 Nest가 스택 트레이스를 함께 찍어 원인이 묻히기 때문이다.
 * 실제 락 확보는 MetaDbService가 한다.
 */
function assertSingleInstance(dataDir: string): void {
  const file = metaDbPath(dataDir);
  if (!existsSync(file)) return;
  const sqlite = new Database(file, { fileMustExist: true });
  try {
    new InstanceLock(sqlite).check();
  } finally {
    sqlite.close();
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  assertSingleInstance(config.dataDir);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    abortOnError: false,
  });
  configureApp(app, config);
  app.enableShutdownHooks();

  await app.listen(config.port);
  Logger.log(`${APP_NAME} API listening on :${config.port}/${API_PREFIX}`, 'Bootstrap');
}

try {
  await bootstrap();
} catch (err) {
  // 운영자가 고칠 수 있는 기동 실패는 스택 트레이스 없이 원인만 출력한다
  if (err instanceof ConfigError || err instanceof InstanceLockError) {
    Logger.error(err.message, 'Bootstrap');
  } else {
    Logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err), 'Bootstrap');
  }
  process.exitCode = 1;
}
