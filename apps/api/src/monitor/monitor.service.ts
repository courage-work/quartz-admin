import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { MonitorData, SnapshotDto } from '@qa/shared';
import { TargetError, collectMonitorData } from '@qa/store';
import { eq } from 'drizzle-orm';
import type { Subscription } from 'rxjs';
import { CLOCK, type Clock } from '../common/clock.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { connections, knownNodes, schedulerSnapshots, schedulers } from '../meta-db/schema.js';
import { TargetsService } from '../targets/targets.service.js';
import { schedulerViewContext } from '../views/context.js';
import { deriveHealth } from './health.js';
import { MonitorHooks, type MonitorTx } from './monitor-hooks.js';
import { MonitorLoop, type LoopStats } from './monitor-loop.js';
import { SchedulerEvents } from './scheduler-events.js';

type SnapshotRow = typeof schedulerSnapshots.$inferSelect;

export const MONITOR_OPTIONS = Symbol('MONITOR_OPTIONS');

export interface MonitorOptions {
  /** false면 기동 시 감시를 시작하지 않는다(API 테스트). 기본 true */
  enabled: boolean;
  /** 동시에 도는 감시 회차 수 (`QA_MONITOR_CONCURRENCY`, 기본 8) */
  concurrency: number;
  /** 감시 1회 제한. 넘으면 실패로 기록한다. 기본 30초 (TRD §9.1) */
  roundTimeoutMs: number;
  /** 첫 회차 지터 상한. 기본 15초 */
  maxInitialJitterMs?: number;
}

export function toSnapshotDto(row: SnapshotRow): SnapshotDto {
  return {
    schedulerId: row.schedulerId,
    polledAt: row.polledAt,
    status: row.status,
    dbNow: row.dbNow,
    clockSkewMs: row.clockSkewMs,
    triggerCounts: row.triggerCounts ?? null,
    nodes: row.nodes ?? null,
    executingCount: row.executingCount,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    consecutiveFailures: row.consecutiveFailures,
  };
}

class RoundTimeout extends Error {}

/**
 * 감시 루프 (TRD §9.1, B-15). 등록한 스케줄러를 각자의 주기로 감시해 `scheduler_snapshots`와
 * `known_nodes`를 갱신하고, 확장 지점(`MonitorHooks`)에 결과를 넘긴다.
 *
 * - 기동하면 메타 저장소의 모든 스케줄러를 지터를 줘서 등록한다. 재시작해도 감시가 저절로 이어진다
 * - 스케줄러 등록·설정 변경·삭제는 `SchedulerEvents`로 받아 바로 반영한다
 * - 대상 DB 하나가 응답하지 않아도 그 스케줄러의 회차만 실패한다. 접속별 풀(§5.2)과 회차 제한(30초)으로
 *   다른 스케줄러의 감시 시점은 밀리지 않는다(NFR-REL-01)
 */
@Injectable()
export class MonitorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MonitorService.name);
  private readonly loop: MonitorLoop;
  private subscription: Subscription | undefined;

  constructor(
    private readonly metaDb: MetaDbService,
    private readonly targets: TargetsService,
    private readonly events: SchedulerEvents,
    private readonly hooks: MonitorHooks,
    @Inject(MONITOR_OPTIONS) private readonly options: MonitorOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.loop = new MonitorLoop({
      concurrency: options.concurrency,
      run: async (id) => {
        await this.poll(id);
      },
      ...(options.maxInitialJitterMs !== undefined
        ? { maxInitialJitterMs: options.maxInitialJitterMs }
        : {}),
    });
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.subscription = this.events.events.subscribe((event) => {
      if (event.type === 'remove') this.loop.remove(event.schedulerId);
      else this.track(event.schedulerId, event.immediate ?? false);
    });
    const rows = this.metaDb.db
      .select({ id: schedulers.id, interval: schedulers.pollIntervalSec })
      .from(schedulers)
      .all();
    for (const row of rows) this.loop.upsert(row.id, row.interval * 1_000);
    this.logger.log(
      `감시 시작: 스케줄러 ${rows.length}개, 동시 실행 ${this.options.concurrency}개`,
    );
  }

  onApplicationShutdown(): void {
    this.subscription?.unsubscribe();
    this.loop.stop();
  }

  get stats(): LoopStats {
    return this.loop.stats;
  }

  isTracking(schedulerId: number): boolean {
    return this.loop.has(schedulerId);
  }

  /** 스케줄러를 감시 대상에 넣거나 주기를 다시 읽는다 */
  private track(schedulerId: number, immediate: boolean): void {
    const row = this.findScheduler(schedulerId);
    if (!row) {
      this.loop.remove(schedulerId);
      return;
    }
    this.loop.upsert(schedulerId, row.pollIntervalSec * 1_000, { immediate });
  }

  /**
   * 감시 1회. 실패해도 던지지 않고 실패 스냅샷을 남긴다.
   * 대상 DB 조회는 `roundTimeoutMs` 안에 끝나야 하며, SQLite 쓰기는 트랜잭션 하나로 묶는다.
   */
  async poll(schedulerId: number): Promise<SnapshotDto | null> {
    const scheduler = this.findScheduler(schedulerId);
    if (!scheduler) {
      this.loop.remove(schedulerId);
      return null;
    }
    const connection = this.metaDb.db
      .select()
      .from(connections)
      .where(eq(connections.id, scheduler.connectionId))
      .get();
    if (!connection) {
      this.loop.remove(schedulerId);
      return null;
    }

    const started = this.clock();
    let data: MonitorData;
    try {
      const ctx = schedulerViewContext(scheduler, connection);
      data = await this.withTimeout(
        this.targets.withConnection(connection, (conn) =>
          collectMonitorData(conn, ctx, {
            checkinMultiplier: scheduler.checkinMultiplier,
            overdueAfterMs: scheduler.misfireThresholdMs + scheduler.overdueGraceMs,
          }),
        ),
      );
    } catch (err) {
      return this.recordFailure(scheduler, err);
    }
    const finished = this.clock();
    // 쿼리 중간 시각과 DB 시각의 차이. 왕복 시간의 절반만큼 오차가 있다
    const clockSkewMs = Math.round(data.dbNow - (started + finished) / 2);
    try {
      return this.metaDb.db.transaction((tx) => {
        const snapshot = this.writeSnapshot(tx, {
          schedulerId,
          polledAt: finished,
          status: deriveHealth(data, scheduler, clockSkewMs),
          dbNow: data.dbNow,
          clockSkewMs,
          triggerCounts: data.triggerCounts,
          nodes: data.nodes,
          executingCount: data.executingCount,
          errorCode: null,
          errorMessage: null,
          consecutiveFailures: 0,
        });
        this.writeKnownNodes(tx, scheduler.id, data, finished);
        this.hooks.run({ ok: true, scheduler, data, snapshot }, tx);
        return snapshot;
      });
    } catch (err) {
      // 스케줄러가 방금 삭제됐거나(외래키) 훅이 실패한 경우. 쓰기는 모두 롤백됐다
      this.logger.error(`감시 결과 저장 실패 (스케줄러 ${schedulerId}): ${String(err)}`);
      return this.findScheduler(schedulerId) ? this.recordFailure(scheduler, err) : null;
    }
  }

  private recordFailure(
    scheduler: typeof schedulers.$inferSelect,
    err: unknown,
  ): SnapshotDto | null {
    const { code, message } = describeFailure(err);
    if (!(err instanceof TargetError) && !(err instanceof RoundTimeout)) {
      this.logger.error(`감시 중 처리하지 못한 오류 (스케줄러 ${scheduler.id}): ${String(err)}`);
    }
    try {
      return this.metaDb.db.transaction((tx) => {
        const previous = tx
          .select()
          .from(schedulerSnapshots)
          .where(eq(schedulerSnapshots.schedulerId, scheduler.id))
          .get();
        // 마지막으로 성공한 값(개수, 노드, DB 시각)은 그대로 두고 상태와 오류만 바꾼다
        const snapshot = this.writeSnapshot(tx, {
          ...(previous ? toSnapshotDto(previous) : emptySnapshot(scheduler.id)),
          polledAt: this.clock(),
          status: 'unreachable',
          errorCode: code,
          errorMessage: message,
          consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        });
        this.hooks.run({ ok: false, scheduler, snapshot }, tx);
        return snapshot;
      });
    } catch (writeErr) {
      this.logger.error(`감시 실패 기록 실패 (스케줄러 ${scheduler.id}): ${String(writeErr)}`);
      return null;
    }
  }

  private writeSnapshot(tx: MonitorTx, snapshot: SnapshotDto): SnapshotDto {
    const { schedulerId, ...values } = snapshot;
    tx.insert(schedulerSnapshots)
      .values({ schedulerId, ...values })
      .onConflictDoUpdate({ target: schedulerSnapshots.schedulerId, set: values })
      .run();
    return snapshot;
  }

  /** 노드 이탈 판정용 (TRD §3.2). 사라진 노드의 행은 지우지 않는다 */
  private writeKnownNodes(
    tx: MonitorTx,
    schedulerId: number,
    data: MonitorData,
    now: number,
  ): void {
    for (const node of data.nodes) {
      const values = {
        lastSeenAt: now,
        lastCheckinTime: node.lastCheckinTime,
        checkinInterval: node.checkinInterval,
      };
      tx.insert(knownNodes)
        .values({ schedulerId, instanceName: node.instanceName, firstSeenAt: now, ...values })
        .onConflictDoUpdate({
          target: [knownNodes.schedulerId, knownNodes.instanceName],
          set: values,
        })
        .run();
    }
  }

  private findScheduler(id: number) {
    return this.metaDb.db.select().from(schedulers).where(eq(schedulers.id, id)).get();
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RoundTimeout()), this.options.roundTimeoutMs);
    });
    promise.catch(() => undefined);
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

function emptySnapshot(schedulerId: number): SnapshotDto {
  return {
    schedulerId,
    polledAt: 0,
    status: 'unreachable',
    dbNow: null,
    clockSkewMs: null,
    triggerCounts: null,
    nodes: null,
    executingCount: null,
    errorCode: null,
    errorMessage: null,
    consecutiveFailures: 0,
  };
}

/** 스냅샷에 남길 원인. 대상 DB 오류는 고정 문구, 그 밖은 내부 정보 없이 남긴다 */
function describeFailure(err: unknown): { code: string; message: string } {
  if (err instanceof TargetError) return { code: err.code, message: err.message };
  if (err instanceof RoundTimeout) {
    return { code: 'TARGET_TIMEOUT', message: '감시 1회가 제한 시간(30초)을 넘었습니다' };
  }
  return { code: 'INTERNAL_ERROR', message: '감시 중 처리하지 못한 오류가 발생했습니다' };
}
