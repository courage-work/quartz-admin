import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { ClockModule } from './common/clock.module.js';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/env.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { HealthController } from './health/health.controller.js';
import { httpLoggerParams } from './logging/http-logger.js';
import { MetaDbModule } from './meta-db/meta-db.module.js';

export interface AppModuleOptions {
  /**
   * 로그 출력 대상. 기본은 stdout이고, 테스트는 로그를 모은다.
   * nestjs-pino는 프로세스마다 pino-http 인스턴스 하나를 쓰므로 처음 만든 앱의 값만 적용된다.
   */
  logStream?: DestinationStream;
}

@Module({})
export class AppModule {
  /** 설정은 main.ts에서 검증을 마친 뒤 넘긴다 */
  static forRoot(config: AppConfig, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(httpLoggerParams(config, options.logStream)),
        ClockModule,
        CryptoModule,
        MetaDbModule.forRoot({ dataDir: config.dataDir }),
        AuditModule,
        AuthModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
