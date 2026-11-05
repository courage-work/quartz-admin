import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './env.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** main.ts에서 검증을 마친 설정을 전역으로 제공한다 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
