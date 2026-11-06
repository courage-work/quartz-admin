import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  TargetError,
  TargetPoolManager,
  detectQuartz,
  dialectFor,
  type PoolTarget,
  type QuartzDetection,
  type TargetConnectInfo,
} from '@qa/store';
import { SecretBox, secretAad } from '../crypto/secret-box.js';
import type { connections } from '../meta-db/schema.js';

export type ConnectionRow = typeof connections.$inferSelect;

/** 감지 함수. 테스트는 대상 DB 없이 결과를 정해 두려고 바꿔 끼운다 */
export const QUARTZ_DETECTOR = Symbol('QUARTZ_DETECTOR');
export type QuartzDetector = typeof detectQuartz;

/**
 * 대상 DB 접근 창구. 접속 행의 비밀번호를 복호화해 `@qa/store` 풀로 연결한다.
 * 복호화한 비밀번호는 이 서비스 밖으로 나가지 않는다.
 */
@Injectable()
export class TargetsService implements OnApplicationShutdown {
  private readonly logger = new Logger(TargetsService.name);

  constructor(
    private readonly pools: TargetPoolManager,
    private readonly secrets: SecretBox,
    @Inject(QUARTZ_DETECTOR) private readonly detector: QuartzDetector,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pools.closeAll();
  }

  /** 저장된 접속의 연결 정보. 비밀번호를 복호화한다 */
  connectInfo(row: ConnectionRow): TargetConnectInfo {
    return {
      kind: row.dbType,
      host: row.host,
      port: row.port,
      username: row.username,
      password: this.secrets.decrypt(row.passwordEnc, secretAad('connections', row.id)),
      database: row.database ?? undefined,
      oracleServiceName: row.oracleServiceName ?? undefined,
      oracleSid: row.oracleSid ?? undefined,
    };
  }

  target(row: ConnectionRow): PoolTarget {
    return { id: row.id, info: this.connectInfo(row) };
  }

  /** 저장된 접속으로 자동 감지를 실행한다 (TRD §5.5) */
  detect(row: ConnectionRow): Promise<QuartzDetection> {
    return this.detectWith(this.target(row), row.schemaName ?? undefined);
  }

  /**
   * 저장하지 않은 접속 정보로 감지한다(연결 테스트). 접속 ID가 없으므로 일회용 풀을 쓰고 끝나면 닫는다.
   * 저장된 접속의 풀을 쓰지 않는 이유는 수정 중인 값(다른 호스트일 수 있음)으로 시험하기 때문이다.
   */
  async detectOnce(info: TargetConnectInfo, schema: string | undefined): Promise<QuartzDetection> {
    const id = `test:${randomUUID()}`;
    try {
      return await this.detectWith({ id, info }, schema);
    } finally {
      await this.pools.invalidate(id);
    }
  }

  /** 접속을 고치거나 지우면 그 풀을 버린다 */
  async forget(connectionId: number): Promise<void> {
    await this.pools.invalidate(connectionId);
  }

  private async detectWith(
    target: PoolTarget,
    schema: string | undefined,
  ): Promise<QuartzDetection> {
    const dialect = dialectFor(target.info.kind);
    if (!dialect) {
      throw new TargetError('TARGET_ERROR', {
        message: `아직 지원하지 않는 DB 종류입니다: ${target.info.kind}`,
      });
    }
    try {
      return await this.pools.withConnection(target, (conn) =>
        this.detector(conn, dialect, { schema }),
      );
    } catch (err) {
      if (err instanceof TargetError) {
        // 접속 정보를 지운 원문만 남긴다 (TRD §5.6)
        this.logger.warn(
          `대상 DB 감지 실패 (${String(target.id)}): ${err.code} ${err.driverCode ?? ''} ${err.detail ?? ''}`.trim(),
        );
      }
      throw err;
    }
  }
}
