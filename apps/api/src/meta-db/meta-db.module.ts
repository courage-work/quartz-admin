import { Global, Module, type DynamicModule } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service.js';
import { MetaDbService } from './meta-db.service.js';
import { META_DB_OPTIONS, resolveMetaDbOptions, type MetaDbOptions } from './tokens.js';

@Global()
@Module({})
export class MetaDbModule {
  /** 옵션은 모듈 초기화 시점에 읽는다(테스트가 import 이후에 환경변수를 바꿀 수 있도록) */
  static forRoot(overrides: Partial<MetaDbOptions> = {}): DynamicModule {
    return {
      module: MetaDbModule,
      providers: [
        { provide: META_DB_OPTIONS, useFactory: () => resolveMetaDbOptions(overrides) },
        MetaDbService,
        MaintenanceService,
      ],
      exports: [MetaDbService, MaintenanceService],
    };
  }
}
