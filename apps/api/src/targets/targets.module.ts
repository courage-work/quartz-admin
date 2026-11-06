import { Global, Module } from '@nestjs/common';
import { TargetPoolManager, createDriverAdapters, detectQuartz } from '@qa/store';
import { QUARTZ_DETECTOR, TargetsService } from './targets.service.js';

/**
 * 대상 DB 접근 (TRD §5). 접속마다 커넥션 풀을 하나씩 두는 `TargetPoolManager`를 앱 전체가 함께 쓴다.
 * 조회·감시·제어 모듈이 모두 쓰므로 전역으로 둔다.
 */
@Global()
@Module({
  providers: [
    { provide: TargetPoolManager, useFactory: () => new TargetPoolManager(createDriverAdapters()) },
    { provide: QUARTZ_DETECTOR, useValue: detectQuartz },
    TargetsService,
  ],
  exports: [TargetPoolManager, TargetsService],
})
export class TargetsModule {}
