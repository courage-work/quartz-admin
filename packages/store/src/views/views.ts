import type {
  ExecutingDto,
  JobDto,
  JobListQuery,
  NodeDto,
  QuartzFeatures,
  TriggerDto,
  TriggerListQuery,
} from '@qa/shared';
import { ALL_GROUPS_PAUSED } from '@qa/shared';
import type { Row, TargetConn } from '../adapter.js';
import type { QuartzDialect } from '../dialect.js';
import { TargetError } from '../errors.js';
import { readBlob, readString, readTime } from '../normalize.js';
import type { TableSet } from '../table-set.js';
import { Binds, containsAny } from './sql.js';

/** 스케줄러 하나를 조회하는 데 필요한 값. 메타 저장소의 `schedulers` 행으로 만든다 */
export interface SchedulerViewContext {
  dialect: QuartzDialect;
  tables: TableSet;
  features: QuartzFeatures;
  schedName: string;
}

/** `pauseAll`이 남기는 표시 행 (`Constants.ALL_GROUPS_PAUSED`). 화면도 쓰므로 `@qa/shared`에 둔다 */
export { ALL_GROUPS_PAUSED };

export interface PageResult<T> {
  items: T[];
  total: number;
}

const str = (row: Row, key: string): string => {
  const v = row[key];
  if (typeof v !== 'string') {
    throw new TargetError('TARGET_ERROR', { detail: `조회 결과에 ${key} 값이 없습니다` });
  }
  return v;
};

/** TRD §9.2 활성 노드 판정 */
export function isActiveNode(
  lastCheckinTime: number | null,
  checkinInterval: number,
  dbNow: number,
  multiplier: number,
): boolean {
  return lastCheckinTime !== null && lastCheckinTime + checkinInterval * multiplier >= dbNow;
}

/** 클러스터 노드 (FR-VIEW-02) */
export async function listNodes(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  opts: { dbNow: number; checkinMultiplier: number },
): Promise<NodeDto[]> {
  const { dialect: d, tables } = ctx;
  const b = new Binds(d);
  const rows = await conn.query(
    `SELECT INSTANCE_NAME AS ${d.quote('N')}, LAST_CHECKIN_TIME AS ${d.quote('L')}, ` +
      `CHECKIN_INTERVAL AS ${d.quote('I')} FROM ${tables.table('SCHEDULER_STATE')} ` +
      `WHERE SCHED_NAME = ${b.add(ctx.schedName)} ORDER BY INSTANCE_NAME`,
    b.values,
  );
  return rows.map((r) => {
    const last = readTime(r.L);
    const interval = d.readLong(r.I) ?? 0;
    return {
      instanceName: str(r, 'N'),
      lastCheckinTime: last,
      checkinInterval: interval,
      active: isActiveNode(last, interval, opts.dbNow, opts.checkinMultiplier),
      sinceCheckinMs: last === null ? null : opts.dbNow - last,
    };
  });
}

/**
 * 일시정지된 트리거 그룹 (FR-VIEW-02). 문자 코드 순으로 정렬한다.
 * DB 정렬 규칙에 맡기면 MySQL 5.7 기본값(`latin1_swedish_ci`)에서 `_$_ALL_GROUPS_PAUSED_$_`가 영문 뒤로 가는 등
 * DB마다 순서가 달라진다. 행이 적고 페이지를 나누지 않으므로 코드에서 정렬한다
 */
export async function listPausedGroups(
  conn: TargetConn,
  ctx: SchedulerViewContext,
): Promise<string[]> {
  const { dialect: d, tables } = ctx;
  const b = new Binds(d);
  const rows = await conn.query(
    `SELECT TRIGGER_GROUP AS ${d.quote('G')} FROM ${tables.table('PAUSED_TRIGGER_GRPS')} ` +
      `WHERE SCHED_NAME = ${b.add(ctx.schedName)}`,
    b.values,
  );
  return rows.map((r) => str(r, 'G')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 잡·트리거 그룹 이름 (그룹 필터 선택지). 이름순으로 `limit`개까지 읽고, 더 있으면 `truncated`로 알린다.
 * `IDX_QRTZ_J_GRP`, `IDX_QRTZ_T_G`(SCHED_NAME, 그룹)를 쓴다
 */
export async function listGroups(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  kind: 'job' | 'trigger',
  limit: number,
): Promise<{ items: string[]; truncated: boolean }> {
  const { dialect: d, tables } = ctx;
  const [table, column] =
    kind === 'job'
      ? ([tables.table('JOB_DETAILS'), 'JOB_GROUP'] as const)
      : ([tables.table('TRIGGERS'), 'TRIGGER_GROUP'] as const);
  const b = new Binds(d);
  const base =
    `SELECT DISTINCT ${column} AS ${d.quote('G')} FROM ${table} ` +
    `WHERE SCHED_NAME = ${b.add(ctx.schedName)} ORDER BY ${column}`;
  const sql = d.paginate(base, b.next, b.next + 1);
  // 하나 더 읽어 잘렸는지 안다
  b.add(limit + 1);
  b.add(0);
  const groups = (await conn.query(sql, b.values)).map((r) => str(r, 'G'));
  return { items: groups.slice(0, limit), truncated: groups.length > limit };
}

// ── 잡 ────────────────────────────────────────────────────

function jobSelect(ctx: SchedulerViewContext, withData: boolean): string {
  const { dialect: d, tables, features: f } = ctx;
  const q = (a: string) => d.quote(a);
  const cols = [
    `j.JOB_GROUP AS ${q('G')}`,
    `j.JOB_NAME AS ${q('N')}`,
    `j.JOB_CLASS_NAME AS ${q('C')}`,
    `j.DESCRIPTION AS ${q('D')}`,
    `j.IS_DURABLE AS ${q('DU')}`,
    f.jobNonconcurrent ? `j.IS_NONCONCURRENT AS ${q('NC')}` : null,
    f.jobUpdateData ? `j.IS_UPDATE_DATA AS ${q('UD')}` : null,
    `j.REQUESTS_RECOVERY AS ${q('RR')}`,
    // 잡의 트리거 수. IDX_QRTZ_T_J(SCHED_NAME, JOB_NAME, JOB_GROUP)를 쓴다
    `(SELECT COUNT(*) FROM ${tables.table('TRIGGERS')} t WHERE t.SCHED_NAME = j.SCHED_NAME ` +
      `AND t.JOB_NAME = j.JOB_NAME AND t.JOB_GROUP = j.JOB_GROUP) AS ${q('TC')}`,
    withData ? `j.JOB_DATA AS ${q('DATA')}` : null,
  ].filter((c): c is string => c !== null);
  return `SELECT ${cols.join(', ')} FROM ${tables.table('JOB_DETAILS')} j`;
}

function toJob(ctx: SchedulerViewContext, r: Row): JobDto {
  const d = ctx.dialect;
  return {
    group: str(r, 'G'),
    name: str(r, 'N'),
    jobClass: str(r, 'C'),
    description: readString(r.D),
    durable: d.readBool(r.DU),
    nonConcurrent: ctx.features.jobNonconcurrent ? d.readBool(r.NC) : null,
    updateData: ctx.features.jobUpdateData ? d.readBool(r.UD) : null,
    requestsRecovery: d.readBool(r.RR),
    triggerCount: d.readLong(r.TC) ?? 0,
  };
}

/** 잡 목록 (FR-VIEW-03). 그룹은 정확히 일치, 검색어는 이름·그룹·클래스 부분 일치 */
export async function listJobs(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  query: Pick<JobListQuery, 'group' | 'q' | 'page' | 'size'>,
): Promise<PageResult<JobDto>> {
  const { dialect: d, tables } = ctx;
  const where = (b: Binds) => {
    const conds = [`j.SCHED_NAME = ${b.add(ctx.schedName)}`];
    if (query.group !== undefined) conds.push(`j.JOB_GROUP = ${b.add(query.group)}`);
    if (query.q !== undefined) {
      conds.push(containsAny(b, ['j.JOB_NAME', 'j.JOB_GROUP', 'j.JOB_CLASS_NAME'], query.q));
    }
    return ` WHERE ${conds.join(' AND ')}`;
  };

  const cb = new Binds(d);
  const countSql = `SELECT COUNT(*) AS ${d.quote('CNT')} FROM ${tables.table('JOB_DETAILS')} j${where(cb)}`;
  const total = d.readLong((await conn.query(countSql, cb.values))[0]?.CNT) ?? 0;

  const b = new Binds(d);
  const base = `${jobSelect(ctx, false)}${where(b)} ORDER BY j.JOB_GROUP, j.JOB_NAME`;
  const sql = d.paginate(base, b.next, b.next + 1);
  b.add(query.size);
  b.add((query.page - 1) * query.size);
  const rows = await conn.query(sql, b.values);
  return { items: rows.map((r) => toJob(ctx, r)), total };
}

// ── 트리거 ────────────────────────────────────────────────

const SIMPROP_COLS = [
  ['STR_PROP_1', 'S1'],
  ['STR_PROP_2', 'S2'],
  ['STR_PROP_3', 'S3'],
  ['INT_PROP_1', 'I1'],
  ['INT_PROP_2', 'I2'],
  ['LONG_PROP_1', 'L1'],
  ['LONG_PROP_2', 'L2'],
  ['DEC_PROP_1', 'D1'],
  ['DEC_PROP_2', 'D2'],
  ['BOOL_PROP_1', 'B1'],
  ['BOOL_PROP_2', 'B2'],
] as const;

function triggerFrom(ctx: SchedulerViewContext): { select: string; from: string } {
  const { dialect: d, tables, features: f } = ctx;
  const q = (a: string) => d.quote(a);
  const join = (key: 'CRON_TRIGGERS' | 'SIMPLE_TRIGGERS' | 'SIMPROP_TRIGGERS', alias: string) =>
    `LEFT JOIN ${tables.table(key)} ${alias} ON ${alias}.SCHED_NAME = t.SCHED_NAME ` +
    `AND ${alias}.TRIGGER_NAME = t.TRIGGER_NAME AND ${alias}.TRIGGER_GROUP = t.TRIGGER_GROUP`;
  const cols = [
    `t.TRIGGER_GROUP AS ${q('G')}`,
    `t.TRIGGER_NAME AS ${q('N')}`,
    `t.JOB_GROUP AS ${q('JG')}`,
    `t.JOB_NAME AS ${q('JN')}`,
    `t.DESCRIPTION AS ${q('D')}`,
    `t.TRIGGER_TYPE AS ${q('TY')}`,
    `t.TRIGGER_STATE AS ${q('ST')}`,
    `t.NEXT_FIRE_TIME AS ${q('NFT')}`,
    `t.PREV_FIRE_TIME AS ${q('PFT')}`,
    `t.START_TIME AS ${q('STT')}`,
    `t.END_TIME AS ${q('ET')}`,
    f.triggerPriority ? `t.PRIORITY AS ${q('PR')}` : null,
    `t.MISFIRE_INSTR AS ${q('MI')}`,
    `t.CALENDAR_NAME AS ${q('CAL')}`,
    `c.CRON_EXPRESSION AS ${q('CE')}`,
    f.cronTimeZone ? `c.TIME_ZONE_ID AS ${q('TZ')}` : null,
    `s.REPEAT_COUNT AS ${q('RC')}`,
    `s.REPEAT_INTERVAL AS ${q('RI')}`,
    `s.TIMES_TRIGGERED AS ${q('TT')}`,
    ...(f.simpropTriggers ? SIMPROP_COLS.map(([col, alias]) => `sp.${col} AS ${q(alias)}`) : []),
  ].filter((c): c is string => c !== null);
  const from = [
    `${tables.table('TRIGGERS')} t`,
    join('CRON_TRIGGERS', 'c'),
    join('SIMPLE_TRIGGERS', 's'),
    f.simpropTriggers ? join('SIMPROP_TRIGGERS', 'sp') : null,
  ]
    .filter((c): c is string => c !== null)
    .join(' ');
  return { select: `SELECT ${cols.join(', ')}`, from };
}

function toTrigger(ctx: SchedulerViewContext, r: Row): TriggerDto {
  const d = ctx.dialect;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const cronExpr = readString(r.CE);
  const hasSimple = r.RC !== null && r.RC !== undefined;
  const hasSimprop =
    ctx.features.simpropTriggers &&
    SIMPROP_COLS.some(([, a]) => r[a] !== null && r[a] !== undefined);
  return {
    group: str(r, 'G'),
    name: str(r, 'N'),
    jobGroup: str(r, 'JG'),
    jobName: str(r, 'JN'),
    description: readString(r.D),
    type: str(r, 'TY'),
    state: str(r, 'ST'),
    nextFireTime: readTime(r.NFT),
    prevFireTime: readTime(r.PFT),
    startTime: readTime(r.STT),
    endTime: readTime(r.ET),
    priority: ctx.features.triggerPriority ? d.readLong(r.PR) : null,
    misfireInstruction: d.readLong(r.MI),
    calendarName: readString(r.CAL),
    cron: cronExpr === null ? null : { expression: cronExpr, timeZone: readString(r.TZ) },
    simple: hasSimple
      ? {
          repeatCount: d.readLong(r.RC) ?? 0,
          repeatIntervalMs: d.readLong(r.RI) ?? 0,
          timesTriggered: d.readLong(r.TT) ?? 0,
        }
      : null,
    simprop: hasSimprop
      ? {
          strings: [readString(r.S1), readString(r.S2), readString(r.S3)],
          ints: [d.readLong(r.I1), d.readLong(r.I2)],
          longs: [d.readLong(r.L1), d.readLong(r.L2)],
          decimals: [num(r.D1), num(r.D2)],
          bools: [d.readBool(r.B1), d.readBool(r.B2)],
        }
      : null,
  };
}

/**
 * 트리거 목록 (FR-VIEW-04). 상태·타입은 여러 개, 그룹은 정확히 일치, 검색어는 트리거 이름·그룹·잡 이름 부분 일치.
 * 다음 실행 시각 정렬은 값이 없는 트리거(NULL, -1)를 뒤로 보낸다.
 */
export async function listTriggers(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  query: Pick<TriggerListQuery, 'state' | 'type' | 'group' | 'q' | 'sort' | 'page' | 'size'>,
): Promise<PageResult<TriggerDto>> {
  const { dialect: d, tables } = ctx;
  const where = (b: Binds) => {
    const conds = [`t.SCHED_NAME = ${b.add(ctx.schedName)}`];
    if (query.state?.length) conds.push(`t.TRIGGER_STATE IN (${b.list(query.state)})`);
    if (query.type?.length) conds.push(`t.TRIGGER_TYPE IN (${b.list(query.type)})`);
    if (query.group !== undefined) conds.push(`t.TRIGGER_GROUP = ${b.add(query.group)}`);
    if (query.q !== undefined) {
      conds.push(containsAny(b, ['t.TRIGGER_NAME', 't.TRIGGER_GROUP', 't.JOB_NAME'], query.q));
    }
    return ` WHERE ${conds.join(' AND ')}`;
  };

  const cb = new Binds(d);
  const countSql = `SELECT COUNT(*) AS ${d.quote('CNT')} FROM ${tables.table('TRIGGERS')} t${where(cb)}`;
  const total = d.readLong((await conn.query(countSql, cb.values))[0]?.CNT) ?? 0;

  const { select, from } = triggerFrom(ctx);
  const order =
    query.sort === 'nextFireTime'
      ? 'CASE WHEN t.NEXT_FIRE_TIME > 0 THEN 0 ELSE 1 END, t.NEXT_FIRE_TIME, t.TRIGGER_GROUP, t.TRIGGER_NAME'
      : 't.TRIGGER_GROUP, t.TRIGGER_NAME';
  const b = new Binds(d);
  const base = `${select} FROM ${from}${where(b)} ORDER BY ${order}`;
  const sql = d.paginate(base, b.next, b.next + 1);
  b.add(query.size);
  b.add((query.page - 1) * query.size);
  const rows = await conn.query(sql, b.values);
  return { items: rows.map((r) => toTrigger(ctx, r)), total };
}

/** 트리거 하나 (스케줄 수정 화면, 명령의 스케줄 읽기). 없으면 null */
export async function getTriggerDetail(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  key: { group: string; name: string },
): Promise<TriggerDto | null> {
  const { select, from } = triggerFrom(ctx);
  const b = new Binds(ctx.dialect);
  const rows = await conn.query(
    `${select} FROM ${from} WHERE t.SCHED_NAME = ${b.add(ctx.schedName)} ` +
      `AND t.TRIGGER_GROUP = ${b.add(key.group)} AND t.TRIGGER_NAME = ${b.add(key.name)}`,
    b.values,
  );
  const row = rows[0];
  return row ? toTrigger(ctx, row) : null;
}

/** 잡 상세: 잡, 연결된 트리거, JobDataMap 원본 (FR-VIEW-03, 08). 없으면 null */
export async function getJobDetail(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  key: { group: string; name: string },
): Promise<{ job: JobDto; triggers: TriggerDto[]; jobData: Buffer | null } | null> {
  const d = ctx.dialect;
  const jb = new Binds(d);
  const jobRows = await conn.query(
    `${jobSelect(ctx, true)} WHERE j.SCHED_NAME = ${jb.add(ctx.schedName)} ` +
      `AND j.JOB_GROUP = ${jb.add(key.group)} AND j.JOB_NAME = ${jb.add(key.name)}`,
    jb.values,
  );
  const row = jobRows[0];
  if (!row) return null;

  const { select, from } = triggerFrom(ctx);
  const tb = new Binds(d);
  const triggerRows = await conn.query(
    `${select} FROM ${from} WHERE t.SCHED_NAME = ${tb.add(ctx.schedName)} ` +
      `AND t.JOB_GROUP = ${tb.add(key.group)} AND t.JOB_NAME = ${tb.add(key.name)} ` +
      `ORDER BY t.TRIGGER_GROUP, t.TRIGGER_NAME`,
    tb.values,
  );
  return {
    job: toJob(ctx, row),
    triggers: triggerRows.map((r) => toTrigger(ctx, r)),
    jobData: readBlob(row.DATA),
  };
}

// ── 실행 중 ───────────────────────────────────────────────

/**
 * 실행 중이거나 획득된 트리거 (FR-VIEW-05). 활성 노드가 아닌 인스턴스의 기록은 `stale`로 표시한다.
 * 정리(삭제)는 하지 않는다. Quartz ClusterManager의 복구 절차를 건너뛰게 되기 때문이다(PRD FR-CTL-12 삭제).
 */
export async function listExecuting(
  conn: TargetConn,
  ctx: SchedulerViewContext,
  opts: { dbNow: number; checkinMultiplier: number },
): Promise<ExecutingDto[]> {
  const { dialect: d, tables, features: f } = ctx;
  const q = (a: string) => d.quote(a);
  const nodes = await listNodes(conn, ctx, opts);
  const active = new Set(nodes.filter((n) => n.active).map((n) => n.instanceName));

  const b = new Binds(d);
  const cols = [
    `ENTRY_ID AS ${q('E')}`,
    `TRIGGER_GROUP AS ${q('G')}`,
    `TRIGGER_NAME AS ${q('N')}`,
    `JOB_GROUP AS ${q('JG')}`,
    `JOB_NAME AS ${q('JN')}`,
    `INSTANCE_NAME AS ${q('I')}`,
    `STATE AS ${q('ST')}`,
    `FIRED_TIME AS ${q('FT')}`,
    f.firedSchedTime ? `SCHED_TIME AS ${q('SCT')}` : null,
    f.firedPriority ? `PRIORITY AS ${q('PR')}` : null,
    `IS_NONCONCURRENT AS ${q('NC')}`,
    `REQUESTS_RECOVERY AS ${q('RR')}`,
  ].filter((c): c is string => c !== null);
  const rows = await conn.query(
    `SELECT ${cols.join(', ')} FROM ${tables.table('FIRED_TRIGGERS')} ` +
      `WHERE SCHED_NAME = ${b.add(ctx.schedName)} ORDER BY FIRED_TIME, ENTRY_ID`,
    b.values,
  );
  return rows.map((r) => {
    const fired = readTime(r.FT);
    const instance = str(r, 'I');
    return {
      entryId: str(r, 'E'),
      triggerGroup: str(r, 'G'),
      triggerName: str(r, 'N'),
      jobGroup: readString(r.JG),
      jobName: readString(r.JN),
      instanceName: instance,
      state: str(r, 'ST'),
      firedTime: fired,
      scheduledTime: f.firedSchedTime ? readTime(r.SCT) : null,
      priority: f.firedPriority ? d.readLong(r.PR) : null,
      nonConcurrent: d.readBool(r.NC),
      requestsRecovery: d.readBool(r.RR),
      elapsedMs: fired === null ? null : opts.dbNow - fired,
      stale: !active.has(instance),
    };
  });
}
