import type { CommandChangeDto } from '@qa/shared';
import type { Row, TargetConn } from '../adapter.js';
import { TargetError } from '../errors.js';
import { Binds } from '../views/sql.js';
import type { CommandTarget, SchedulerCommandContext } from './types.js';

const str = (row: Row, key: string): string => {
  const v = row[key];
  if (typeof v !== 'string') {
    throw new TargetError('TARGET_ERROR', { detail: `조회 결과에 ${key} 값이 없습니다` });
  }
  return v;
};

/**
 * 명령 대상 트리거를 읽는다. `where`는 `t` 별칭의 TRIGGERS 조건이고 SCHED_NAME 조건은 여기서 붙인다.
 * `lockWaitSec`를 주면 읽은 행을 잠근다(TRD §7.1 d). 순서는 그룹·이름이라 여러 행을 잠글 때도 순서가 일정하다.
 */
export async function selectTriggerTargets(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  where: (b: Binds) => string,
  lockWaitSec?: number,
): Promise<CommandTarget[]> {
  const { dialect: d, tables } = ctx;
  const q = (a: string) => d.quote(a);
  const b = new Binds(d);
  const sql =
    `SELECT t.TRIGGER_GROUP AS ${q('G')}, t.TRIGGER_NAME AS ${q('N')}, ` +
    `t.JOB_GROUP AS ${q('JG')}, t.JOB_NAME AS ${q('JN')}, t.TRIGGER_STATE AS ${q('ST')} ` +
    `FROM ${tables.table('TRIGGERS')} t ` +
    `WHERE t.SCHED_NAME = ${b.add(ctx.schedName)} AND ${where(b)} ` +
    `ORDER BY t.TRIGGER_GROUP, t.TRIGGER_NAME` +
    (lockWaitSec === undefined ? '' : ` ${d.forUpdate(lockWaitSec)}`);
  const rows = await conn.query(sql, b.values);
  return rows.map((r) => ({
    group: str(r, 'G'),
    name: str(r, 'N'),
    jobGroup: str(r, 'JG'),
    jobName: str(r, 'JN'),
    state: str(r, 'ST'),
  }));
}

/**
 * 트리거 상태를 바꾼다. 항상 `WHERE TRIGGER_STATE = 바꾸기 전 상태`를 붙인다. 행 잠금으로 이미 보호되지만,
 * 잠금이 빠진 경로가 생겨도 잘못 덮어쓰지 않게 하는 이중 안전장치다(TRD §7.2). 바뀐 행 수를 돌려준다.
 */
export async function applyStateChanges(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  changes: readonly CommandChangeDto[],
): Promise<number> {
  const { dialect: d, tables } = ctx;
  let changed = 0;
  for (const c of changes) {
    const b = new Binds(d);
    changed += await conn.execute(
      `UPDATE ${tables.table('TRIGGERS')} SET TRIGGER_STATE = ${b.add(c.to)} ` +
        `WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND TRIGGER_GROUP = ${b.add(c.group)} ` +
        `AND TRIGGER_NAME = ${b.add(c.name)} AND TRIGGER_STATE = ${b.add(c.from)}`,
      b.values,
    );
  }
  return changed;
}
