import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';

export interface HealthBody {
  status: 'ok' | 'error';
  checks?: Record<string, 'ok' | 'error'>;
}

/**
 * 컨테이너 헬스체크 (TRD §11.1, NFR-OPS-03). API 접두어(`/api/v1`) 밖에 두고 로그인 없이 부른다.
 * 응답에 내부 정보(경로, 오류 메시지)는 넣지 않는다.
 */
@Public()
@Controller()
export class HealthController {
  constructor(private readonly metaDb: MetaDbService) {}

  /** 프로세스가 요청을 받을 수 있는지 */
  @Get('healthz')
  healthz(): HealthBody {
    return { status: 'ok' };
  }

  /** 메타데이터 저장소를 읽을 수 있고 마이그레이션이 적용됐는지. 아니면 503 */
  @Get('readyz')
  readyz(@Res({ passthrough: true }) res: Response): HealthBody {
    const checks: Record<string, 'ok' | 'error'> = {
      sqlite: this.check(() => this.metaDb.sqlite.prepare('SELECT 1').get()),
      migrations: this.check(() => {
        const row = this.metaDb.sqlite
          .prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations')
          .get() as { n: number };
        if (row.n < 1) throw new Error('no migrations');
      }),
    };
    const ok = Object.values(checks).every((v) => v === 'ok');
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'error', checks };
  }

  private check(fn: () => unknown): 'ok' | 'error' {
    try {
      fn();
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
