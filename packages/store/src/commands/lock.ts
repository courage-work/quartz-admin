import type { TargetConn } from '../adapter.js';
import { Binds } from '../views/sql.js';
import type { SchedulerCommandContext } from './types.js';

/** 도구가 쓰는 Quartz 잠금 행 이름. `STATE_ACCESS`는 클러스터 체크인 전용이라 쓰지 않는다 (TRD §7.2) */
export const TRIGGER_ACCESS = 'TRIGGER_ACCESS';

/** 잠금 대기 제한(초). 넘으면 `LOCK_TIMEOUT` (FR-CTL-00c) */
export const LOCK_WAIT_SEC = 5;

/** 잠금을 어떻게 잡았는지. `inserted`는 행이 없어 새로 넣은 경우다 */
export type LockAcquisition = 'locked' | 'inserted';

/**
 * Quartz `TRIGGER_ACCESS` 잠금 행을 잡는다 (TRD §7.1 c, `StdRowLockSemaphore`와 같은 방식).
 *
 * - `SELECT … FOR UPDATE [WAIT n]`로 행을 잠근다. 대기가 제한을 넘으면 드라이버 오류가 `LOCK_TIMEOUT`이 된다
 * - 행이 없으면 INSERT한다. 넣은 행은 커밋 전까지 이 트랜잭션이 잠그고 있으므로 다시 SELECT하지 않는다
 * - 다른 쪽이 동시에 INSERT해 키가 겹치면 ROLLBACK하고 한 번만 다시 시도한다(이번에는 행이 있어 SELECT로 잠근다)
 *
 * 호출자가 트랜잭션을 끝낸다(COMMIT 또는 ROLLBACK).
 */
export async function acquireTriggerAccess(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  waitSec: number = LOCK_WAIT_SEC,
): Promise<LockAcquisition> {
  const { dialect: d, tables } = ctx;
  const locks = tables.table('LOCKS');
  for (let attempt = 0; ; attempt++) {
    const b = new Binds(d);
    const rows = await conn.query(
      `SELECT LOCK_NAME AS ${d.quote('L')} FROM ${locks} ` +
        `WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND LOCK_NAME = ${b.add(TRIGGER_ACCESS)} ` +
        d.forUpdate(waitSec),
      b.values,
    );
    if (rows.length > 0) return 'locked';

    const ins = new Binds(d);
    try {
      await conn.execute(
        `INSERT INTO ${locks} (SCHED_NAME, LOCK_NAME) ` +
          `VALUES (${ins.add(ctx.schedName)}, ${ins.add(TRIGGER_ACCESS)})`,
        ins.values,
      );
      return 'inserted';
    } catch (err) {
      if (attempt === 0 && d.isDuplicateKey(err)) {
        await conn.rollback();
        continue;
      }
      throw err;
    }
  }
}
