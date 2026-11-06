import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX, APP_NAME } from '@qa/shared';
import Database from 'better-sqlite3';
import { Logger } from 'nestjs-pino';
import { existsSync } from 'node:fs';
import { pino } from 'pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ConfigError, LOG_LEVELS, type LogLevel, loadConfig } from './config/env.js';
import { pinoOptions } from './logging/http-logger.js';
import { InstanceLock, InstanceLockError } from './meta-db/instance-lock.js';
import { metaDbPath } from './meta-db/meta-db.js';
import { defaultWebDir } from './web/web-assets.js';

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
    // 초기화 중 로그도 pino(JSON)로 내보내도록 Logger가 준비될 때까지 모아 둔다
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  configureApp(app, config, { webDir: defaultWebDir() });
  app.enableShutdownHooks();

  await app.listen(config.port);
  logger.log(`${APP_NAME} API listening on :${config.port}/${API_PREFIX}`, 'Bootstrap');
}

/** Nest가 뜨기 전 실패도 JSON으로 남긴다. 레벨은 환경변수 값이 올바를 때만 따른다 */
function bootstrapLogger() {
  const raw = process.env.QA_LOG_LEVEL;
  const level: LogLevel = LOG_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : 'info';
  return pino(pinoOptions(level)).child({ context: 'Bootstrap' });
}

try {
  await bootstrap();
} catch (err) {
  const log = bootstrapLogger();
  // 운영자가 고칠 수 있는 기동 실패는 스택 트레이스 없이 원인만 출력한다
  if (err instanceof ConfigError || err instanceof InstanceLockError) {
    log.fatal(err.message);
  } else {
    log.fatal({ err }, '기동하지 못했습니다');
  }
  process.exitCode = 1;
}
