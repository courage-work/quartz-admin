import type { MonitorData, TriggerRef } from '@qa/shared';
import type { TargetConn } from '../adapter.js';
import { queryDbNowMillis } from '../dialect.js';
import { readTime } from '../normalize.js';
import { Binds } from './sql.js';
import { listNodes, type SchedulerViewContext } from './views.js';

/** 연체 판정 대상 상태 (TRD §9.2 OVERDUE) */
const OVERDUE_STATES = ['WAITING', 'ACQUIRED'] as const;
/** 알림 규칙이 개별 트리거를 봐야 하는 상태 (TRIGGER_ERROR, BLOCKED_LONG) */
const WATCHED_STATES = ['ERROR', 'BLOCKED', 'PAUSED_BLOCKED'] as const;

export interface CollectOptions {
  checkinMultiplier: number;
  /** `misfire_threshold_ms + overdue_grace_ms` */
  overdueAfterMs: number;
  /** 연체 트리거 목록 상한. 기본 500(ERROR·BLOCKED 목록과 같음). 알림의 적용 범위와 재개 제외가 목록을 걸러 쓴다 */
  overdueLimit?: number;
  /** ERROR·BLOCKED 트리거 목록 상한. 기본 500 */
  watchedLimit?: number;
}

/**
 * 감시 1회에 읽는 값 (TRD §9.1). 모두 같은 커넥션에서 조회만 한다.
 * DB 시각 → 상태별 개수 → 노드 → 연체 수와 상위 목록 → ERROR·BLOCKED 목록 → 실행 중 수.
 */
export async function collectMonitorData(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  opts: CollectOptions,
): Promise<MonitorData> {
  const { dialect: d, tables } = ctx;
  const q = (a: string) => d.quote(a);
  const T = tables.table('TRIGGERS');
  const dbNow = await queryDbNowMillis(conn, d);

  // 상태별 트리거 수. IDX_QRTZ_T_STATE(SCHED_NAME, TRIGGER_STATE)
  const cb = new Binds(d);
  const countRows = await conn.query(
    `SELECT TRIGGER_STATE AS ${q('ST')}, COUNT(*) AS ${q('CNT')} FROM ${T} ` +
      `WHERE SCHED_NAME = ${cb.add(ctx.schedName)} GROUP BY TRIGGER_STATE`,
    cb.values,
  );
  const triggerCounts: Record<string, number> = {};
  for (const r of countRows) triggerCounts[String(r.ST)] = d.readLong(r.CNT) ?? 0;

  const nodes = await listNodes(conn, ctx, { dbNow, checkinMultiplier: opts.checkinMultiplier });

  // 연체: WAITING·ACQUIRED이고 다음 실행 시각이 dbNow - (misfire + 유예)보다 이른 트리거
  const overdueBefore = dbNow - opts.overdueAfterMs;
  const overdueWhere = (b: Binds) =>
    ` WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND TRIGGER_STATE IN (${b.list(OVERDUE_STATES)}) ` +
    `AND NEXT_FIRE_TIME > 0 AND NEXT_FIRE_TIME < ${b.add(overdueBefore)}`;
  const ob = new Binds(d);
  const overdueCount =
    d.readLong(
      (
        await conn.query(`SELECT COUNT(*) AS ${q('CNT')} FROM ${T}${overdueWhere(ob)}`, ob.values)
      )[0]?.CNT,
    ) ?? 0;
  let overdue: (TriggerRef & { nextFireTime: number })[] = [];
  if (overdueCount > 0) {
    const lb = new Binds(d);
    const sql = d.paginate(
      `SELECT TRIGGER_GROUP AS ${q('G')}, TRIGGER_NAME AS ${q('N')}, NEXT_FIRE_TIME AS ${q('NFT')} ` +
        `FROM ${T}${overdueWhere(lb)} ORDER BY NEXT_FIRE_TIME, TRIGGER_GROUP, TRIGGER_NAME`,
      lb.next,
      lb.next + 1,
    );
    lb.add(opts.overdueLimit ?? 500);
    lb.add(0);
    overdue = (await conn.query(sql, lb.values)).map((r) => ({
      group: String(r.G),
      name: String(r.N),
      nextFireTime: readTime(r.NFT) ?? 0,
    }));
  }

  const wb = new Binds(d);
  const watchedSql = d.paginate(
    `SELECT TRIGGER_GROUP AS ${q('G')}, TRIGGER_NAME AS ${q('N')}, TRIGGER_STATE AS ${q('ST')} FROM ${T} ` +
      `WHERE SCHED_NAME = ${wb.add(ctx.schedName)} AND TRIGGER_STATE IN (${wb.list(WATCHED_STATES)}) ` +
      `ORDER BY TRIGGER_GROUP, TRIGGER_NAME`,
    wb.next,
    wb.next + 1,
  );
  wb.add(opts.watchedLimit ?? 500);
  wb.add(0);
  const watched = (await conn.query(watchedSql, wb.values)).map((r) => ({
    group: String(r.G),
    name: String(r.N),
    state: String(r.ST),
  }));

  const fb = new Binds(d);
  const executingCount =
    d.readLong(
      (
        await conn.query(
          `SELECT COUNT(*) AS ${q('CNT')} FROM ${tables.table('FIRED_TRIGGERS')} ` +
            `WHERE SCHED_NAME = ${fb.add(ctx.schedName)}`,
          fb.values,
        )
      )[0]?.CNT,
    ) ?? 0;

  return {
    dbNow,
    triggerCounts,
    nodes,
    executingCount,
    overdueCount,
    overdue,
    errorTriggers: watched
      .filter((t) => t.state === 'ERROR')
      .map(({ group, name }) => ({ group, name })),
    blockedTriggers: watched
      .filter((t) => t.state !== 'ERROR')
      .map(({ group, name, state }) => ({ group, name, state })),
  };
}
