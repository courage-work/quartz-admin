import { Module } from '@nestjs/common';
import { MetaDbModule } from './meta-db/meta-db.module.js';

@Module({
  imports: [MetaDbModule.forRoot()],
})
export class AppModule {}
