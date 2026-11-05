import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InstanceLock } from './instance-lock.js';
import { createMetaDb, openSqlite, runMigrations, type MetaDb, type Sqlite } from './meta-db.js';
import { META_DB_OPTIONS, type MetaDbOptions } from './tokens.js';

/**
 * 메타데이터 저장소 연결.
 * 생성 순서: 파일 열기 → 단일 인스턴스 락 → 마이그레이션. 락을 확보하지 못하면 생성자에서 실패한다.
 */
@Injectable()
export class MetaDbService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MetaDbService.name);
  readonly sqlite: Sqlite;
  readonly db: MetaDb;
  private readonly lock: InstanceLock;

  constructor(@Inject(META_DB_OPTIONS) readonly options: MetaDbOptions) {
    this.sqlite = openSqlite(options.dataDir);
    try {
      this.lock = new InstanceLock(this.sqlite);
      this.lock.acquire();
      this.db = createMetaDb(this.sqlite);
      runMigrations(this.db);
    } catch (err) {
      this.sqlite.close();
      throw err;
    }
    this.logger.log(`메타데이터 저장소 준비 완료: ${options.dataDir}`);
  }

  onApplicationBootstrap(): void {
    this.lock.startHeartbeat(() => {
      // 하트비트가 30초 넘게 멈춰 다른 인스턴스가 락을 가져간 경우. 중복 실행을 막기 위해 종료한다
      this.logger.fatal(
        '단일 인스턴스 락을 잃었습니다. 다른 인스턴스와의 중복 실행을 막기 위해 종료합니다.',
      );
      process.exit(1);
    });
  }

  onApplicationShutdown(): void {
    this.lock.release();
    this.sqlite.close();
  }
}
