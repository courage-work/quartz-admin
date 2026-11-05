import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { backupDir, createBackup, pruneBackups } from './backup.js';
import { MetaDbService } from './meta-db.service.js';
import { META_DB_OPTIONS, type MetaDbOptions } from './tokens.js';

/** 보존 정책 작업. 각 기능 모듈이 등록한다 (TRD §3.3) */
export interface RetentionTask {
  name: string;
  /** 지운 행 수를 돌려준다 */
  run(now: number): number;
}

export interface MaintenanceReport {
  backupFile?: string;
  prunedBackups: string[];
  tasks: { name: string; removed?: number; error?: string }[];
  backupError?: string;
}

/** now 이후 처음 오는 로컬 시각 hour:00까지 남은 시간 */
export function msUntilNextRun(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** 매일 한 번 백업과 보존 정리를 실행한다 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly tasks: RetentionTask[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly metaDb: MetaDbService,
    @Inject(META_DB_OPTIONS) private readonly options: MetaDbOptions,
  ) {}

  register(task: RetentionTask): void {
    this.tasks.push(task);
  }

  async runOnce(now: Date = new Date()): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { prunedBackups: [], tasks: [] };
    const dir = backupDir(this.options.dataDir);
    try {
      report.backupFile = await createBackup(this.metaDb.sqlite, dir, now);
      report.prunedBackups = pruneBackups(dir);
    } catch (err) {
      report.backupError = errorMessage(err);
      this.logger.error(`백업 실패: ${report.backupError}`);
    }
    for (const task of this.tasks) {
      try {
        report.tasks.push({ name: task.name, removed: task.run(now.getTime()) });
      } catch (err) {
        report.tasks.push({ name: task.name, error: errorMessage(err) });
        this.logger.error(`보존 정리 실패 (${task.name}): ${errorMessage(err)}`);
      }
    }
    this.logger.log(
      `일일 유지보수 완료: 백업=${report.backupFile ?? '실패'}, 정리 작업 ${report.tasks.length}개`,
    );
    return report;
  }

  onApplicationBootstrap(): void {
    this.schedule();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    const delay = msUntilNextRun(new Date(), this.options.maintenanceHour);
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
