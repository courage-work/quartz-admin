import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { SecretBox } from './secret-box.js';

@Global()
@Module({
  providers: [
    {
      provide: SecretBox,
      useFactory: (config: AppConfig) =>
        new SecretBox(config.encryption.keys, config.encryption.activeKeyId),
      inject: [APP_CONFIG],
    },
  ],
  exports: [SecretBox],
})
export class CryptoModule {}
