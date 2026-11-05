import { Global, Module, type DynamicModule } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service.js';
import { MetaDbService } from './meta-db.service.js';
import { DEFAULT_MAINTENANCE_HOUR, META_DB_OPTIONS, type MetaDbOptions } from './tokens.js';

@Global()
@Module({})
export class MetaDbModule {
  static forRoot(options: Pick<MetaDbOptions, 'dataDir'> & Partial<MetaDbOptions>): DynamicModule {
    const resolved: MetaDbOptions = {
      maintenanceHour: DEFAULT_MAINTENANCE_HOUR,
      ...options,
    };
    return {
      module: MetaDbModule,
      providers: [
        { provide: META_DB_OPTIONS, useValue: resolved },
        MetaDbService,
        MaintenanceService,
      ],
      exports: [MetaDbService, MaintenanceService],
    };
  }
}
