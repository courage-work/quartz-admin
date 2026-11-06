import { Injectable, Logger } from '@nestjs/common';
import type { MonitorData, SnapshotDto } from '@qa/shared';
import type { MetaDb } from '../meta-db/meta-db.js';
import type { schedulers } from '../meta-db/schema.js';

type SchedulerRow = typeof schedulers.$inferSelect;
/** 감시 1회의 SQLite 트랜잭션 */
export type MonitorTx = Parameters<Parameters<MetaDb['transaction']>[0]>[0];

export type MonitorOutcome =
  | { ok: true; scheduler: SchedulerRow; data: MonitorData; snapshot: SnapshotDto }
  | { ok: false; scheduler: SchedulerRow; snapshot: SnapshotDto };

/**
 * 감시 결과를 받아 처리하는 확장 지점 (B-15 → B-24 알림 규칙 평가).
 * 스냅샷을 저장한 **같은 SQLite 트랜잭션** 안에서 동기로 부른다(TRD §9.1: 감시 1회당 트랜잭션 하나).
 * 훅이 던지면 그 회차의 쓰기 전체가 롤백되고 감시 실패로 남는다.
 */
export interface MonitorHook {
  readonly name: string;
  afterPoll(outcome: MonitorOutcome, tx: MonitorTx): void;
}

@Injectable()
export class MonitorHooks {
  private readonly logger = new Logger(MonitorHooks.name);
  private readonly hooks: MonitorHook[] = [];

  register(hook: MonitorHook): void {
    this.hooks.push(hook);
    this.logger.log(`감시 훅 등록: ${hook.name}`);
  }

  run(outcome: MonitorOutcome, tx: MonitorTx): void {
    for (const hook of this.hooks) hook.afterPoll(outcome, tx);
  }
}
