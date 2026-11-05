import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/env.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { MetaDbModule } from './meta-db/meta-db.module.js';

@Module({})
export class AppModule {
  /** 설정은 main.ts에서 검증을 마친 뒤 넘긴다 */
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        CryptoModule,
        MetaDbModule.forRoot({ dataDir: config.dataDir }),
      ],
    };
  }
}
