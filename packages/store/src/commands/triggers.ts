import { randomBytes } from 'node:crypto';
import {
  COMMAND_TARGETS_LISTED,
  PAUSE_TRIGGER_TRANSITIONS,
  RESUMABLE_TRIGGER_STATES,
  type CommandChangeDto,
  type CommandInsertDto,
  type CommandNoticeDto,
  type TriggerKey,
} from '@qa/shared';
import type { Row, TargetConn } from '../adapter.js';
import { TargetError } from '../errors.js';
import { readTime } from '../normalize.js';
import { Binds } from '../views/sql.js';
import { ALL_GROUPS_PAUSED, listPausedGroups } from '../views/views.js';
import type { CommandPlan, CommandTarget, SchedulerCommandContext } from './types.js';

const str = (row: Row, key: string): string => {
  const v = row[key];
  if (typeof v !== 'string') {
    throw new TargetError('TARGET_ERROR', { detail: `조회 결과에 ${key} 값이 없습니다` });
  }
  return v;
};

/** 잡 키를 집합에 넣을 때 쓰는 문자열 */
export const jobKeyOf = (group: string, name: string): string => `${group}\u0000${name}`;

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
    `t.JOB_GROUP AS ${q('JG')}, t.JOB_NAME AS ${q('JN')}, t.TRIGGER_STATE AS ${q('ST')}, ` +
    `t.NEXT_FIRE_TIME AS ${q('NFT')} ` +
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
    nextFireTime: readTime(r.NFT),
  }));
}

/**
 * `PAUSED_TRIGGER_GRPS`에 있는 그룹 중 `relevant`에 든 것. 이름순이다.
 * 이 표는 Quartz도 `TRIGGER_ACCESS` 안에서만 바꾸므로 잠금 안에서 읽으면 행을 따로 잠그지 않아도 된다.
 */
export async function selectPausedGroups(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  relevant: Iterable<string>,
): Promise<string[]> {
  const want = new Set(relevant);
  if (want.size === 0) return [];
  const all = await listPausedGroups(conn, ctx);
  return [...new Set(all.filter((g) => want.has(g)))].sort();
}

/**
 * 동시 실행 금지로 실행 중인 잡 (`JSS.checkBlockedState`). 같은 잡의 `FIRED_TRIGGERS` 행 중
 * `IS_NONCONCURRENT`가 참인 것이 있으면 그 잡의 트리거는 재개할 때 BLOCKED가 된다. 획득만 된 행은
 * `JOB_NAME`이 NULL이고 `IS_NONCONCURRENT`가 거짓이라 판정에 쓰이지 않는다(TRD §7.3, 부록 A.3 R-06).
 * 불리언 저장 형식이 스키마마다 달라 SQL에서 비교하지 않고 읽어서 판정한다.
 */
export async function selectBlockingJobs(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
): Promise<Set<string>> {
  const { dialect: d, tables } = ctx;
  const q = (a: string) => d.quote(a);
  const b = new Binds(d);
  const rows = await conn.query(
    `SELECT JOB_GROUP AS ${q('JG')}, JOB_NAME AS ${q('JN')}, IS_NONCONCURRENT AS ${q('NC')} ` +
      `FROM ${tables.table('FIRED_TRIGGERS')} ` +
      `WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND JOB_NAME IS NOT NULL`,
    b.values,
  );
  const blocking = new Set<string>();
  for (const r of rows) {
    if (typeof r.JG !== 'string' || typeof r.JN !== 'string') continue;
    if (d.readBool(r.NC) === true) blocking.add(jobKeyOf(r.JG, r.JN));
  }
  return blocking;
}

/** `JOB_DETAILS`에 조건에 맞는 잡이 있는지. `where`는 `j` 별칭의 조건이다 */
export async function jobExists(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  where: (b: Binds) => string,
): Promise<boolean> {
  const { dialect: d, tables } = ctx;
  const b = new Binds(d);
  const rows = await conn.query(
    `SELECT COUNT(*) AS ${d.quote('C')} FROM ${tables.table('JOB_DETAILS')} j ` +
      `WHERE j.SCHED_NAME = ${b.add(ctx.schedName)} AND ${where(b)}`,
    b.values,
  );
  return (d.readLong(rows[0]?.C) ?? 0) > 0;
}

/** 앞쪽 몇 개의 트리거 키. 경고·차단 사유에 붙인다 */
export function listedKeys(targets: readonly TriggerKey[]): TriggerKey[] {
  return targets.slice(0, COMMAND_TARGETS_LISTED).map(({ group, name }) => ({ group, name }));
}

const PAUSE: Readonly<Record<string, string | undefined>> = PAUSE_TRIGGER_TRANSITIONS;
const RESUMABLE: ReadonlySet<string> = new Set(RESUMABLE_TRIGGER_STATES);

/**
 * 일시정지할 트리거 상태 (`JSS.pauseTrigger`). WAITING·ACQUIRED → PAUSED, BLOCKED → PAUSED_BLOCKED.
 * 그 밖의 상태(PAUSED, PAUSED_BLOCKED, ERROR, COMPLETE)는 바꾸지 않는다(부록 A.2 P-04).
 */
export function pauseChanges(targets: readonly CommandTarget[]): CommandChangeDto[] {
  return targets.flatMap((t) => {
    const to = PAUSE[t.state];
    return to === undefined ? [] : [{ group: t.group, name: t.name, from: t.state, to }];
  });
}

export interface ResumeOptions {
  dbNow: number;
  /** 동시 실행 금지로 실행 중인 잡 */
  blockingJobs: ReadonlySet<string>;
  /** 실행 뒤에도 `PAUSED_TRIGGER_GRPS`에 남는 그룹(전체 일시정지 표시 포함) */
  pausedAfter: ReadonlySet<string>;
}

export interface ResumePlan {
  changes: CommandChangeDto[];
  /** 그룹 일시정지 안의 지난 트리거. 있으면 명령을 거부한다(TRD §7.4) */
  inPausedGroup: CommandTarget[];
  /** 실행 시각이 지나 Quartz 노드의 misfire 처리에 맡기는 트리거 */
  misfired: CommandTarget[];
  /** 다음 실행 시각이 없어 바꾸지 않는 트리거 (`JSS.resumeTrigger`, 부록 A.3 R-08) */
  noNextFire: CommandTarget[];
}

/**
 * 재개할 트리거 상태 (`JSS.resumeTrigger`, `JSS.checkBlockedState`, TRD §7.3·§7.4).
 *
 * - PAUSED·PAUSED_BLOCKED만 바꾼다. NEXT_FIRE_TIME이 없으면 바꾸지 않는다
 * - 새 상태는 같은 잡이 동시 실행 금지로 실행 중이면 BLOCKED, 아니면 WAITING이다
 * - NEXT_FIRE_TIME은 다시 계산하지 않는다. 지났으면 노드의 MisfireHandler가 처리한다
 * - 실행 뒤에도 그룹(또는 전체)이 일시정지 상태로 남고 NEXT_FIRE_TIME이 지났으면, MisfireHandler가 다시 PAUSED로
 *   되돌려 Quartz와 결과가 달라지므로 거부 대상으로 모은다
 */
export function resumeChanges(targets: readonly CommandTarget[], opts: ResumeOptions): ResumePlan {
  const plan: ResumePlan = { changes: [], inPausedGroup: [], misfired: [], noNextFire: [] };
  const allPaused = opts.pausedAfter.has(ALL_GROUPS_PAUSED);
  for (const t of targets) {
    if (!RESUMABLE.has(t.state)) continue;
    if (t.nextFireTime === null) {
      plan.noNextFire.push(t);
      continue;
    }
    if (t.nextFireTime < opts.dbNow) {
      if (allPaused || opts.pausedAfter.has(t.group)) {
        plan.inPausedGroup.push(t);
        continue;
      }
      plan.misfired.push(t);
    }
    const to = opts.blockingJobs.has(jobKeyOf(t.jobGroup, t.jobName)) ? 'BLOCKED' : 'WAITING';
    plan.changes.push({ group: t.group, name: t.name, from: t.state, to });
  }
  return plan;
}

/** 재개 계획을 핸들러 계획으로 옮긴다. 경고와 거부 사유 문구를 붙인다 */
export function resumePlanOf(
  resume: ResumePlan,
  rest: Pick<CommandPlan, 'groupChanges'> & { warnings?: CommandNoticeDto[] },
): CommandPlan {
  const inserts: CommandInsertDto[] = [];
  const warnings: CommandNoticeDto[] = [...(rest.warnings ?? [])];
  if (resume.inPausedGroup.length > 0) {
    return {
      changes: [],
      groupChanges: [],
      inserts,
      warnings,
      rejection: {
        code: 'RESUME_IN_PAUSED_GROUP',
        message:
          '일시정지된 그룹 안에서 실행 시각이 지난 트리거는 따로 재개할 수 없습니다. ' +
          'Quartz와 같은 결과를 보장할 수 없기 때문입니다. 그룹을 먼저 재개하세요',
        triggers: listedKeys(resume.inPausedGroup),
      },
    };
  }
  if (resume.misfired.length > 0) {
    warnings.push({
      code: 'MISFIRE_DELEGATED',
      message:
        '실행 시각이 지난 트리거가 있습니다. 재개하면 Quartz 노드가 misfire 정책에 따라 ' +
        '최대 1분(misfireThreshold) 안에 처리합니다',
      triggers: listedKeys(resume.misfired),
    });
  }
  if (resume.noNextFire.length > 0) {
    warnings.push({
      code: 'NO_NEXT_FIRE_TIME',
      message: '다음 실행 시각이 없는 트리거는 재개해도 상태가 바뀌지 않습니다',
      triggers: listedKeys(resume.noNextFire),
    });
  }
  return {
    changes: resume.changes,
    groupChanges: rest.groupChanges,
    inserts,
    warnings,
    rejection: null,
  };
}

/** 바뀌는 것이 없을 때 붙이는 경고 */
export function noChangeWarning(plan: CommandPlan, message: string): CommandPlan {
  if (plan.rejection || plannedRows(plan) > 0) return plan;
  return { ...plan, warnings: [{ code: 'NO_CHANGE', message }, ...plan.warnings] };
}

/** 계획이 바꿀 행 수(트리거 상태, 그룹 행, 새 트리거). 적용한 행 수와 비교한다 */
export function plannedRows(
  plan: Pick<CommandPlan, 'changes' | 'groupChanges' | 'inserts'>,
): number {
  return plan.changes.length + plan.groupChanges.length + plan.inserts.length;
}

/** 한 UPDATE에 넣는 트리거 이름 수. Oracle의 IN 목록 상한(1,000)보다 작게 둔다 */
const NAMES_PER_UPDATE = 500;

/**
 * 트리거 상태를 바꾼다. 그룹과 바꾸기 전·후 상태가 같은 트리거를 묶어 `TRIGGER_NAME IN (…)`으로 한 번에 바꾼다.
 * 그룹 명령처럼 대상이 많을 때 잠금을 잡고 있는 시간을 줄이기 위해서다.
 * 항상 `WHERE TRIGGER_STATE = 바꾸기 전 상태`를 붙인다. 행 잠금으로 이미 보호되지만, 잠금이 빠진 경로가 생겨도
 * 잘못 덮어쓰지 않게 하는 이중 안전장치다(TRD §7.2). 바뀐 행 수를 돌려준다.
 */
export async function applyStateChanges(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  changes: readonly CommandChangeDto[],
): Promise<number> {
  const { dialect: d, tables } = ctx;
  const batches = new Map<string, { group: string; from: string; to: string; names: string[] }>();
  for (const c of changes) {
    const key = `${c.group}\u0000${c.from}\u0000${c.to}`;
    const batch = batches.get(key);
    if (batch) batch.names.push(c.name);
    else batches.set(key, { group: c.group, from: c.from, to: c.to, names: [c.name] });
  }
  let changed = 0;
  for (const { group, from, to, names } of batches.values()) {
    for (let i = 0; i < names.length; i += NAMES_PER_UPDATE) {
      const b = new Binds(d);
      changed += await conn.execute(
        `UPDATE ${tables.table('TRIGGERS')} SET TRIGGER_STATE = ${b.add(to)} ` +
          `WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND TRIGGER_GROUP = ${b.add(group)} ` +
          `AND TRIGGER_STATE = ${b.add(from)} ` +
          `AND TRIGGER_NAME IN (${b.list(names.slice(i, i + NAMES_PER_UPDATE))})`,
        b.values,
      );
    }
  }
  return changed;
}

/**
 * Quartz `QuartzScheduler.newTriggerId`와 같은 형식의 트리거 이름: `MT_` + 음이 아닌 난수 long을 30~36진법으로
 */
export function newTriggerName(now: number = Date.now()): string {
  const r = BigInt.asUintN(63, randomBytes(8).readBigUInt64BE());
  return `MT_${r.toString(30 + (now % 7))}`;
}

async function triggerExists(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  group: string,
  name: string,
): Promise<boolean> {
  const { dialect: d, tables } = ctx;
  const b = new Binds(d);
  const rows = await conn.query(
    `SELECT COUNT(*) AS ${d.quote('C')} FROM ${tables.table('TRIGGERS')} ` +
      `WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND TRIGGER_GROUP = ${b.add(group)} ` +
      `AND TRIGGER_NAME = ${b.add(name)}`,
    b.values,
  );
  return (d.readLong(rows[0]?.C) ?? 0) > 0;
}

/** 겹치지 않는 이름을 찾을 때까지 다시 만드는 횟수. Quartz도 겹치면 이름을 다시 만든다(`QS.triggerJob`) */
const NAME_ATTEMPTS = 5;

/**
 * 즉시 실행 트리거를 넣는다 (TRD §7.5, `Delegate.insertTrigger`, `insertSimpleTrigger`).
 * 이름은 잠금 안에서 겹치지 않는지 확인한 뒤 정한다. Quartz도 트리거를 같은 잠금 안에서 넣으므로 이것으로 충분하고,
 * INSERT가 키 중복으로 실패해 트랜잭션이 깨지는 DB(PostgreSQL)도 피할 수 있다.
 * JOB_DATA와 CALENDAR_NAME은 넣지 않아 NULL이 된다(Quartz도 빈 맵이면 NULL).
 */
async function insertTrigger(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  ins: CommandInsertDto,
): Promise<CommandInsertDto> {
  const { dialect: d, tables, features } = ctx;
  let name: string | null = null;
  for (let i = 0; i < NAME_ATTEMPTS && name === null; i++) {
    const candidate = newTriggerName();
    if (!(await triggerExists(conn, ctx, ins.group, candidate))) name = candidate;
  }
  if (name === null) {
    throw new TargetError('TARGET_ERROR', {
      detail: '겹치지 않는 트리거 이름을 만들지 못했습니다',
    });
  }
  const b = new Binds(d);
  const cols: [string, string][] = [
    ['SCHED_NAME', b.add(ctx.schedName)],
    ['TRIGGER_NAME', b.add(name)],
    ['TRIGGER_GROUP', b.add(ins.group)],
    ['JOB_NAME', b.add(ins.jobName)],
    ['JOB_GROUP', b.add(ins.jobGroup)],
    ['DESCRIPTION', b.add(ins.description)],
    ['NEXT_FIRE_TIME', b.add(ins.startTime)],
    ['PREV_FIRE_TIME', b.add(-1)],
    ...(features.triggerPriority ? ([['PRIORITY', b.add(5)]] as [string, string][]) : []),
    ['TRIGGER_STATE', b.add(ins.state)],
    ['TRIGGER_TYPE', b.add('SIMPLE')],
    ['START_TIME', b.add(ins.startTime)],
    ['END_TIME', b.add(0)],
    ['MISFIRE_INSTR', b.add(0)],
  ];
  const inserted = await conn.execute(
    `INSERT INTO ${tables.table('TRIGGERS')} (${cols.map(([c]) => c).join(', ')}) ` +
      `VALUES (${cols.map(([, v]) => v).join(', ')})`,
    b.values,
  );
  const s = new Binds(d);
  await conn.execute(
    `INSERT INTO ${tables.table('SIMPLE_TRIGGERS')} ` +
      `(SCHED_NAME, TRIGGER_NAME, TRIGGER_GROUP, REPEAT_COUNT, REPEAT_INTERVAL, TIMES_TRIGGERED) ` +
      `VALUES (${s.add(ctx.schedName)}, ${s.add(name)}, ${s.add(ins.group)}, ${s.add(0)}, ${s.add(0)}, ${s.add(0)})`,
    s.values,
  );
  if (inserted !== 1) {
    throw new TargetError('TARGET_ERROR', { detail: '즉시 실행 트리거를 넣지 못했습니다' });
  }
  return { ...ins, name };
}

export interface AppliedPlan {
  /** 바뀐 행 수(트리거 상태, 그룹 행, 새 트리거) */
  changed: number;
  /** 실제로 넣은 트리거(이름 포함) */
  inserts: CommandInsertDto[];
}

/**
 * 계획을 적용한다. `PAUSED_TRIGGER_GRPS` 행, 트리거 상태, 새 트리거 순서로 바꾸고 바뀐 행 수를 돌려준다.
 * 그룹 행은 계획이 지금 상태를 보고 정했으므로(없을 때만 넣고 있을 때만 지움) 행마다 1이어야 한다.
 */
export async function applyPlan(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  plan: Pick<CommandPlan, 'changes' | 'groupChanges' | 'inserts'>,
): Promise<AppliedPlan> {
  const { dialect: d, tables } = ctx;
  let changed = 0;
  for (const g of plan.groupChanges) {
    const b = new Binds(d);
    changed += await conn.execute(
      g.paused
        ? `INSERT INTO ${tables.table('PAUSED_TRIGGER_GRPS')} (SCHED_NAME, TRIGGER_GROUP) ` +
            `VALUES (${b.add(ctx.schedName)}, ${b.add(g.group)})`
        : `DELETE FROM ${tables.table('PAUSED_TRIGGER_GRPS')} ` +
            `WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND TRIGGER_GROUP = ${b.add(g.group)}`,
      b.values,
    );
  }
  changed += await applyStateChanges(conn, ctx, plan.changes);
  const inserts: CommandInsertDto[] = [];
  for (const ins of plan.inserts) {
    inserts.push(await insertTrigger(conn, ctx, ins));
    changed++;
  }
  return { changed, inserts };
}
