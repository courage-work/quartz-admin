import { Global, Module } from '@nestjs/common';
import { CLOCK, systemClock } from './clock.js';

/** 현재 시각을 전역으로 제공한다. 테스트는 `overrideProvider(CLOCK)`로 바꾼다 */
@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
