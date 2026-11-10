import type { CommandExpected, QuartzCommand } from '@qa/shared';
import { describe, expect, it } from 'vitest';
import type { BindValue, Row, TargetConn } from '../adapter.js';
import { TargetError } from '../errors.js';
import { oracleDialect } from '../oracle/dialect.js';
import { QUARTZ_REQUIRED_TABLES } from '../quartz-tables.js';
import { createTableSet } from '../table-set.js';
import { ALL_GROUPS_PAUSED } from '../views/views.js';
import {
  CommandRejection,
  executeCommand,
  expectedOf,
  previewCommand,
  sameExpected,
  sameTargets,
} from './index.js';
import { newTriggerName } from './triggers.js';
import type { SchedulerCommandContext } from './types.js';

const ctx: SchedulerCommandContext = {
  dialect: oracleDialect,
  tables: createTableSet(oracleDialect, {
    schema: 'Q',
    tables: Object.fromEntries(QUARTZ_REQUIRED_TABLES.map((t) => [t, `QRTZ_${t}`])),
  }),
  features: {
    simpropTriggers: false,
    triggerPriority: true,
    firedPriority: true,
    firedSchedTime: true,
    jobNonconcurrent: true,
    jobUpdateData: true,
    cronTimeZone: true,
  },
  schedName: 'S',
};

const DB_NOW = 1_762_400_000_000;
const FUTURE = DB_NOW + 60_000;
const PAST = DB_NOW - 5 * 60_000;
const PAUSE: QuartzCommand = { type: 'pauseTrigger', trigger: { group: 'g', name: 't' } };
const RESUME: QuartzCommand = { type: 'resumeTrigger', trigger: { group: 'g', name: 't' } };

interface FakeTrigger {
  group: string;
  name: string;
  jobGroup: string;
  jobName: string;
  state: string;
  nft: number | null;
  /** 스케줄 수정 테스트용. 기본은 SIMPLE(1분 간격 무한 반복) */
  type?: 'CRON' | 'SIMPLE';
  cron?: { expression: string; timeZone: string | null };
  simple?: { repeatCount: number; repeatInterval: number; timesTriggered: number };
  startTime?: number;
  endTime?: number;
  calendar?: string;
}

interface FakeDb {
  triggers: FakeTrigger[];
  pausedGroups: string[];
  /** FIRED_TRIGGERS 행. `jobName`이 null이면 획득만 된 행이다 */
  fired: {
    jobGroup: string | null;
    jobName: string | null;
    nonConcurrent: boolean;
    trigger?: { group: string; name: string };
  }[];
  /** JOB_DETAILS 행 (`그룹/이름`) */
  jobs: string[];
  /** durable이 아닌 잡(`그룹/이름`). 나머지는 durable이다 */
  nonDurable: string[];
  /** SCHEDULER_STATE 행 */
  nodes: { name: string; lastCheckin: number; interval: number }[];
  /** 즉시 실행으로 넣은 트리거의 INSERT 값(컬럼 → 값) */
  inserted: Record<string, BindValue>[];
}

interface Call {
  kind: 'query' | 'execute' | 'commit' | 'rollback';
  sql?: string;
  binds?: readonly BindValue[];
}

const trig = (name: string, state: string, more: Partial<FakeTrigger> = {}): FakeTrigger => ({
  group: 'g',
  name,
  jobGroup: 'jg',
  jobName: 'j',
  state,
  nft: FUTURE,
  ...more,
});

const clone = (db: FakeDb): FakeDb => ({
  triggers: db.triggers.map((t) => ({ ...t })),
  pausedGroups: [...db.pausedGroups],
  fired: db.fired.map((f) => ({ ...f })),
  jobs: [...db.jobs],
  nonDurable: [...db.nonDurable],
  nodes: db.nodes.map((n) => ({ ...n })),
  inserted: db.inserted.map((r) => ({ ...r })),
});

/** 트리거 상세 조회(LEFT JOIN) 한 행 */
function detailRow(t: FakeTrigger): Row {
  const type = t.type ?? 'SIMPLE';
  const simple =
    type === 'SIMPLE'
      ? (t.simple ?? { repeatCount: -1, repeatInterval: 60_000, timesTriggered: 3 })
      : null;
  return {
    G: t.group,
    N: t.name,
    JG: t.jobGroup,
    JN: t.jobName,
    D: null,
    TY: type,
    ST: t.state,
    NFT: t.nft ?? -1,
    PFT: -1,
    STT: t.startTime ?? DB_NOW - 86_400_000,
    ET: t.endTime ?? 0,
    PR: 5,
    MI: 0,
    CAL: t.calendar ?? null,
    CE: type === 'CRON' ? (t.cron?.expression ?? '0 0 12 * * ?') : null,
    TZ: type === 'CRON' ? (t.cron?.timeZone ?? 'UTC') : null,
    RC: simple?.repeatCount ?? null,
    RI: simple?.repeatInterval ?? null,
    TT: simple?.timesTriggered ?? null,
  };
}

/**
 * SQL 모양에 따라 답하는 가짜 커넥션. 트리거, 그룹 일시정지, 실행 기록, 잡 행을 메모리에 두고
 * UPDATE·INSERT·DELETE가 바꾼다. 커밋하지 않고 되돌리면 마지막 커밋 상태로 돌아간다.
 */
class FakeConn implements TargetConn {
  readonly kind = 'oracle' as const;
  readonly calls: Call[] = [];
  inTransaction = false;
  committed: FakeDb;
  private pending: FakeDb;

  constructor(
    db: Partial<FakeDb>,
    private readonly opts: {
      lockRow?: boolean;
      lockError?: TargetError;
      /** 첫 INSERT가 키 중복으로 실패한 뒤에는 행이 생긴다 */
      insertDuplicate?: boolean;
      /** 트리거 UPDATE가 0행을 돌려준다(잠금을 거치지 않은 쓰기를 흉내 낸다) */
      updateMisses?: boolean;
      /** 이미 쓰고 있는 것으로 볼 트리거 이름(이름이 겹치면 다시 만드는지 확인) */
      takenNames?: string[];
    } = {},
  ) {
    const full: FakeDb = {
      triggers: db.triggers ?? [],
      pausedGroups: db.pausedGroups ?? [],
      fired: db.fired ?? [],
      jobs: db.jobs ?? [...new Set((db.triggers ?? []).map((t) => `${t.jobGroup}/${t.jobName}`))],
      nonDurable: db.nonDurable ?? [],
      nodes: db.nodes ?? [{ name: 'node-1', lastCheckin: DB_NOW - 1_000, interval: 7_500 }],
      inserted: db.inserted ?? [],
    };
    this.committed = clone(full);
    this.pending = clone(full);
  }

  /** 지금 트랜잭션에서 보이는 트리거 하나의 상태 */
  state(name: string, db: FakeDb = this.committed): string | undefined {
    return db.triggers.find((t) => t.name === name)?.state;
  }

  query<R extends Row = Row>(sql: string, binds: readonly BindValue[] = []): Promise<R[]> {
    this.calls.push({ kind: 'query', sql, binds });
    if (this.opts.lockError && sql.includes('QRTZ_LOCKS'))
      return Promise.reject(this.opts.lockError);
    return Promise.resolve(this.answer(sql, binds) as R[]);
  }

  private answer(sql: string, binds: readonly BindValue[]): Row[] {
    const db = this.pending;
    if (sql.includes('SYSTIMESTAMP')) return [{ NOW_MS: DB_NOW }];
    if (sql.includes('QRTZ_LOCKS'))
      return this.opts.lockRow === false ? [] : [{ L: 'TRIGGER_ACCESS' }];
    if (sql.includes('QRTZ_PAUSED_TRIGGER_GRPS')) {
      return [...db.pausedGroups].sort().map((g) => ({ G: g }));
    }
    if (sql.includes('QRTZ_SCHEDULER_STATE')) {
      return db.nodes.map((n) => ({ N: n.name, L: n.lastCheckin, I: n.interval }));
    }
    // 잡 상세(getJobDetail). 트리거 수 하위 질의에 QRTZ_TRIGGERS가 있어 먼저 본다
    if (sql.includes('JOB_CLASS_NAME')) {
      const key = `${String(binds[1])}/${String(binds[2])}`;
      if (!db.jobs.includes(key)) return [];
      const [g, n] = key.split('/');
      return [
        {
          G: g,
          N: n,
          C: 'x.Job',
          D: null,
          DU: db.nonDurable.includes(key) ? '0' : '1',
          NC: '0',
          UD: '0',
          RR: '0',
          TC: db.triggers.filter((t) => t.jobGroup === g && t.jobName === n).length,
          DATA: Buffer.from('k=v'),
        },
      ];
    }
    if (sql.includes('COUNT(*)') && sql.includes('QRTZ_TRIGGERS')) {
      const [, group, name] = binds;
      const taken =
        db.triggers.some((t) => t.group === group && t.name === name) ||
        this.opts.takenNames?.includes(name as string);
      return [{ C: taken ? 1 : 0 }];
    }
    // 삭제의 실행 중 조회: 잡의 FIRED_TRIGGERS 행(트리거 키)
    if (sql.includes('QRTZ_FIRED_TRIGGERS') && sql.includes('TRIGGER_GROUP AS')) {
      return db.fired
        .filter((f) => f.jobGroup === binds[1] && f.jobName === binds[2] && f.trigger)
        .map((f) => ({ G: f.trigger!.group, N: f.trigger!.name }));
    }
    if (sql.includes('QRTZ_FIRED_TRIGGERS')) {
      return db.fired
        .filter((f) => f.jobName !== null)
        .map((f) => ({ JG: f.jobGroup, JN: f.jobName, NC: f.nonConcurrent ? '1' : '0' }));
    }
    if (sql.includes('QRTZ_JOB_DETAILS')) {
      const keys = db.jobs.filter((k) => {
        const [g, n] = k.split('/');
        return sql.includes('j.JOB_NAME') ? g === binds[1] && n === binds[2] : g === binds[1];
      });
      return [{ C: keys.length }];
    }
    if (sql.includes('LEFT JOIN') && sql.includes('QRTZ_TRIGGERS')) {
      const [, group, name] = binds;
      // 잡의 트리거 전체(getJobDetail) 또는 트리거 하나(getTriggerDetail)
      const byJob = sql.includes('t.JOB_NAME = ');
      return db.triggers
        .filter((x) =>
          byJob ? x.jobGroup === group && x.jobName === name : x.group === group && x.name === name,
        )
        .map((t) => detailRow(t));
    }
    if (sql.includes('QRTZ_TRIGGERS')) {
      const where = sql.slice(sql.indexOf(' WHERE '), sql.indexOf(' ORDER BY '));
      const match = (t: FakeTrigger): boolean => {
        if (where.includes('t.TRIGGER_NAME')) return t.group === binds[1] && t.name === binds[2];
        if (where.includes('t.JOB_NAME')) return t.jobGroup === binds[1] && t.jobName === binds[2];
        if (where.includes('t.TRIGGER_GROUP = ')) return t.group === binds[1];
        if (where.includes('t.JOB_GROUP = ')) return t.jobGroup === binds[1];
        throw new Error(`예상하지 못한 조건: ${sql}`);
      };
      return db.triggers
        .filter(match)
        .sort((a, b) => (a.group + a.name < b.group + b.name ? -1 : 1))
        .map((t) => ({
          G: t.group,
          N: t.name,
          JG: t.jobGroup,
          JN: t.jobName,
          ST: t.state,
          NFT: t.nft ?? -1,
        }));
    }
    throw new Error(`예상하지 못한 SQL: ${sql}`);
  }

  execute(sql: string, binds: readonly BindValue[] = []): Promise<number> {
    this.calls.push({ kind: 'execute', sql, binds });
    this.inTransaction = true;
    return Promise.resolve().then(() => this.write(sql, binds));
  }

  private write(sql: string, binds: readonly BindValue[]): number | Promise<number> {
    const db = this.pending;
    if (/^DELETE FROM "Q"\."QRTZ_(SIMPLE|CRON|SIMPROP|BLOB)_TRIGGERS"/.test(sql)) {
      const [, group, name] = binds;
      const t = db.triggers.find((x) => x.group === group && x.name === name);
      const kind = /QRTZ_(\w+)_TRIGGERS/.exec(sql)?.[1];
      return t && (t.type ?? 'SIMPLE') === kind ? 1 : 0;
    }
    if (sql.startsWith('DELETE FROM "Q"."QRTZ_TRIGGERS"')) {
      const [, group, name] = binds;
      const before = db.triggers.length;
      db.triggers = db.triggers.filter((x) => !(x.group === group && x.name === name));
      return before - db.triggers.length;
    }
    if (sql.startsWith('DELETE FROM "Q"."QRTZ_JOB_DETAILS"')) {
      const key = `${String(binds[1])}/${String(binds[2])}`;
      const before = db.jobs.length;
      db.jobs = db.jobs.filter((k) => k !== key);
      return before - db.jobs.length;
    }
    return this.writeOther(sql, binds);
  }

  private writeOther(sql: string, binds: readonly BindValue[]): Promise<number> {
    const db = this.pending;
    if (sql.startsWith('INSERT INTO "Q"."QRTZ_LOCKS"')) {
      if (this.opts.insertDuplicate) {
        this.opts.insertDuplicate = false;
        this.opts.lockRow = true;
        return Promise.reject(new TargetError('TARGET_ERROR', { driverCode: 'ORA-00001' }));
      }
      return Promise.resolve(1);
    }
    if (sql.startsWith('UPDATE "Q"."QRTZ_CRON_TRIGGERS"')) {
      const [expression, timeZone, , group, name] = binds;
      const t = db.triggers.find((x) => x.group === group && x.name === name);
      if (!t) return Promise.resolve(0);
      t.cron = { expression: expression as string, timeZone: timeZone as string };
      return Promise.resolve(1);
    }
    if (sql.startsWith('UPDATE "Q"."QRTZ_SIMPLE_TRIGGERS"')) {
      const [repeatCount, repeatInterval, timesTriggered, , group, name] = binds;
      const t = db.triggers.find((x) => x.group === group && x.name === name);
      if (!t) return Promise.resolve(0);
      t.simple = {
        repeatCount: repeatCount as number,
        repeatInterval: repeatInterval as number,
        timesTriggered: timesTriggered as number,
      };
      return Promise.resolve(1);
    }
    if (sql.startsWith('UPDATE "Q"."QRTZ_TRIGGERS" SET NEXT_FIRE_TIME')) {
      const simple = sql.includes('START_TIME');
      const [nft, start] = binds;
      const [group, name, from] = binds.slice(simple ? 3 : 2);
      const t = db.triggers.find((x) => x.group === group && x.name === name && x.state === from);
      if (!t) return Promise.resolve(0);
      t.nft = nft as number;
      if (simple) t.startTime = start as number;
      return Promise.resolve(1);
    }
    if (sql.startsWith('UPDATE "Q"."QRTZ_TRIGGERS"')) {
      if (this.opts.updateMisses) return Promise.resolve(0);
      const [to, , group, from, ...names] = binds;
      let n = 0;
      for (const t of db.triggers) {
        if (t.group === group && t.state === from && names.includes(t.name)) {
          t.state = to as string;
          n++;
        }
      }
      return Promise.resolve(n);
    }
    if (sql.startsWith('INSERT INTO "Q"."QRTZ_TRIGGERS"')) {
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(', ');
      const row = Object.fromEntries(cols.map((c, i) => [c, binds[i]!]));
      db.inserted.push(row);
      db.triggers.push({
        group: row.TRIGGER_GROUP as string,
        name: row.TRIGGER_NAME as string,
        jobGroup: row.JOB_GROUP as string,
        jobName: row.JOB_NAME as string,
        state: row.TRIGGER_STATE as string,
        nft: row.NEXT_FIRE_TIME as number,
      });
      return Promise.resolve(1);
    }
    if (sql.startsWith('INSERT INTO "Q"."QRTZ_SIMPLE_TRIGGERS"')) {
      return Promise.resolve(1);
    }
    if (sql.startsWith('INSERT INTO "Q"."QRTZ_PAUSED_TRIGGER_GRPS"')) {
      const group = binds[1] as string;
      if (db.pausedGroups.includes(group)) {
        return Promise.reject(new TargetError('TARGET_ERROR', { driverCode: 'ORA-00001' }));
      }
      db.pausedGroups.push(group);
      return Promise.resolve(1);
    }
    if (sql.startsWith('DELETE FROM "Q"."QRTZ_PAUSED_TRIGGER_GRPS"')) {
      const before = db.pausedGroups.length;
      db.pausedGroups = db.pausedGroups.filter((g) => g !== binds[1]);
      return Promise.resolve(before - db.pausedGroups.length);
    }
    return Promise.reject(new Error(`예상하지 못한 SQL: ${sql}`));
  }

  commit(): Promise<void> {
    this.calls.push({ kind: 'commit' });
    this.committed = clone(this.pending);
    this.inTransaction = false;
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.calls.push({ kind: 'rollback' });
    this.pending = clone(this.committed);
    this.inTransaction = false;
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  sqls(kind: Call['kind']): string[] {
    return this.calls.filter((c) => c.kind === kind).map((c) => c.sql ?? '');
  }

  writes(): string[] {
    return this.sqls('execute').filter((s) => !s.includes('QRTZ_LOCKS'));
  }
}

const one = (state: string, more: Partial<FakeTrigger> = {}) =>
  new FakeConn({ triggers: [trig('t', state, more)] });

const expectedOf1 = (state: string, pausedGroups: string[] = []): CommandExpected => ({
  triggers: [{ group: 'g', name: 't', state }],
  pausedGroups,
});

/** 미리보기 값 그대로 실행한다. 화면이 하는 순서와 같다 */
async function previewThenRun(conn: FakeConn, command: QuartzCommand) {
  const preview = await previewCommand(conn, ctx, command);
  return executeCommand(conn, ctx, command, expectedOf(preview.subject));
}

const rejected = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

describe('sameTargets·sameExpected (FR-CTL-00e)', () => {
  const refs = (state: string) => [{ group: 'g', name: 't', state }];

  it('Quartz getTriggerState 분류로 비교한다. WAITING과 ACQUIRED, PAUSED와 PAUSED_BLOCKED는 같다', () => {
    expect(sameTargets(refs('WAITING'), refs('ACQUIRED'))).toBe(true);
    expect(sameTargets(refs('PAUSED'), refs('PAUSED_BLOCKED'))).toBe(true);
    expect(sameTargets(refs('WAITING'), refs('PAUSED'))).toBe(false);
    expect(sameTargets(refs('WAITING'), refs('BLOCKED'))).toBe(false);
  });

  it('대상 집합이 다르면 다르다. 순서는 보지 않는다', () => {
    const a = { group: 'g', name: 'a', state: 'WAITING' };
    const b = { group: 'g', name: 'b', state: 'PAUSED' };
    expect(sameTargets([a, b], [b, a])).toBe(true);
    expect(sameTargets([a], [a, b])).toBe(false);
    expect(sameTargets([a, a], [a, b])).toBe(false);
    expect(sameTargets([a], [{ ...a, group: 'h' }])).toBe(false);
  });

  it('관련 그룹의 일시정지 여부도 같아야 한다', () => {
    expect(sameExpected(expectedOf1('PAUSED', ['g']), expectedOf1('PAUSED', ['g']))).toBe(true);
    expect(sameExpected(expectedOf1('PAUSED', ['a', 'g']), expectedOf1('PAUSED', ['g', 'a']))).toBe(
      true,
    );
    expect(sameExpected(expectedOf1('PAUSED', ['g']), expectedOf1('PAUSED'))).toBe(false);
  });
});

describe('executeCommand (TRD §7.1)', () => {
  it('잠금 행 → 대상 행 순서로 잠그고, 조건부 UPDATE 뒤 다시 읽어 커밋한다', async () => {
    const conn = one('WAITING');
    const out = await executeCommand(conn, ctx, PAUSE, expectedOf1('WAITING'));

    expect(out).toMatchObject({
      dbNow: DB_NOW,
      lock: 'locked',
      changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
      groupChanges: [],
      warnings: [],
    });
    expect(out.before.triggers[0]?.state).toBe('WAITING');
    expect(out.after.triggers[0]?.state).toBe('PAUSED');
    expect(conn.state('t')).toBe('PAUSED');

    const queries = conn.sqls('query');
    expect(queries[0]).toMatch(/FROM "Q"\."QRTZ_LOCKS" .*LOCK_NAME = :p2 FOR UPDATE WAIT 5$/);
    expect(conn.calls[0]?.binds).toEqual(['S', 'TRIGGER_ACCESS']);
    expect(queries[2]).toMatch(/FROM "Q"\."QRTZ_TRIGGERS" t .* FOR UPDATE WAIT 5$/);
    // 변경 후 조회는 이미 잠근 행이라 다시 잠그지 않는다
    expect(queries[3]).not.toContain('FOR UPDATE');
    const [update] = conn.calls.filter((c) => c.kind === 'execute');
    expect(update?.sql).toContain('AND TRIGGER_STATE = :p4 AND TRIGGER_NAME IN (:p5)');
    expect(update?.binds).toEqual(['PAUSED', 'S', 'g', 'WAITING', 't']);
    expect(conn.calls.at(-1)?.kind).toBe('commit');
  });

  it('BLOCKED는 PAUSED_BLOCKED로, 화면에서 본 WAITING이 ACQUIRED가 됐어도 실행한다', async () => {
    const blocked = one('BLOCKED');
    const out = await executeCommand(blocked, ctx, PAUSE, expectedOf1('BLOCKED'));
    expect(out.changes).toEqual([{ group: 'g', name: 't', from: 'BLOCKED', to: 'PAUSED_BLOCKED' }]);

    const acquired = one('ACQUIRED');
    await executeCommand(acquired, ctx, PAUSE, expectedOf1('WAITING'));
    expect(acquired.state('t')).toBe('PAUSED');
  });

  it('바뀌는 것이 없으면 UPDATE 없이 커밋하고 NO_CHANGE를 알린다 (P-04)', async () => {
    for (const state of ['PAUSED', 'PAUSED_BLOCKED', 'ERROR', 'COMPLETE']) {
      const conn = one(state);
      const out = await executeCommand(conn, ctx, PAUSE, expectedOf1(state));
      expect(out.changes).toEqual([]);
      expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE']);
      expect(conn.writes()).toEqual([]);
      expect(conn.state('t')).toBe(state);
    }
  });

  it('잠금 행이 없으면 넣고 그 트랜잭션에서 계속한다 (X-02)', async () => {
    const conn = new FakeConn({ triggers: [trig('t', 'WAITING')] }, { lockRow: false });
    const out = await executeCommand(conn, ctx, PAUSE, expectedOf1('WAITING'));
    expect(out.lock).toBe('inserted');
    expect(conn.sqls('execute')[0]).toBe(
      'INSERT INTO "Q"."QRTZ_LOCKS" (SCHED_NAME, LOCK_NAME) VALUES (:p1, :p2)',
    );
    expect(conn.state('t')).toBe('PAUSED');
  });

  it('잠금 행 INSERT가 키 중복이면 되돌리고 한 번 다시 잠근다', async () => {
    const conn = new FakeConn(
      { triggers: [trig('t', 'WAITING')] },
      { lockRow: false, insertDuplicate: true },
    );
    const out = await executeCommand(conn, ctx, PAUSE, expectedOf1('WAITING'));
    expect(out.lock).toBe('locked');
    expect(conn.calls.map((c) => c.kind).slice(0, 4)).toEqual([
      'query',
      'execute',
      'rollback',
      'query',
    ]);
    expect(conn.state('t')).toBe('PAUSED');
  });

  it('기대 상태와 다르면 바꾸지 않고 되돌리며 최신 상태를 돌려준다 (X-04)', async () => {
    const conn = one('PAUSED');
    const err = await rejected(executeCommand(conn, ctx, PAUSE, expectedOf1('WAITING')));
    expect(err).toBeInstanceOf(CommandRejection);
    expect(err).toMatchObject({ code: 'STATE_CONFLICT', current: expectedOf1('PAUSED') });
    expect(conn.writes()).toEqual([]);
    expect(conn.calls.at(-1)?.kind).toBe('rollback');
  });

  it('잠금 대기 초과는 LOCK_TIMEOUT 그대로 던지고 되돌린다 (X-01)', async () => {
    const conn = new FakeConn(
      { triggers: [trig('t', 'WAITING')] },
      { lockError: new TargetError('LOCK_TIMEOUT', { driverCode: 'ORA-30006' }) },
    );
    await expect(executeCommand(conn, ctx, PAUSE, expectedOf1('WAITING'))).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });
    expect(conn.calls.map((c) => c.kind)).toEqual(['query', 'rollback']);
    expect(conn.state('t')).toBe('WAITING');
  });

  it('조건부 UPDATE가 계획보다 적게 바뀌면 되돌린다', async () => {
    const conn = new FakeConn({ triggers: [trig('t', 'WAITING')] }, { updateMisses: true });
    await expect(executeCommand(conn, ctx, PAUSE, expectedOf1('WAITING'))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(conn.sqls('commit')).toEqual([]);
    expect(conn.calls.at(-1)?.kind).toBe('rollback');
  });

  it('대상이 없으면 NOT_FOUND', async () => {
    const conn = new FakeConn({});
    await expect(executeCommand(conn, ctx, PAUSE, expectedOf1('WAITING'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(conn.calls.at(-1)?.kind).toBe('rollback');
  });

  it('같은 그룹·상태의 트리거는 500개씩 묶어 UPDATE한다', async () => {
    const triggers = Array.from({ length: 1200 }, (_, i) =>
      trig(`t${String(i).padStart(4, '0')}`, 'WAITING'),
    );
    const conn = new FakeConn({ triggers });
    const out = await previewThenRun(conn, { type: 'pauseTriggerGroup', group: 'g' });
    expect(out.changes).toHaveLength(1200);
    const updates = conn.writes().filter((s) => s.startsWith('UPDATE'));
    expect(updates).toHaveLength(3);
    expect(conn.committed.triggers.every((t) => t.state === 'PAUSED')).toBe(true);
  });
});

describe('resumeTrigger (부록 A.3)', () => {
  it('PAUSED는 WAITING으로, NEXT_FIRE_TIME은 그대로 (R-01)', async () => {
    const conn = one('PAUSED');
    const out = await previewThenRun(conn, RESUME);
    expect(out.changes).toEqual([{ group: 'g', name: 't', from: 'PAUSED', to: 'WAITING' }]);
    expect(out.warnings).toEqual([]);
    expect(conn.committed.triggers[0]?.nft).toBe(FUTURE);
  });

  it('같은 잡이 동시 실행 금지로 실행 중이면 BLOCKED (R-02, R-03)', async () => {
    for (const state of ['PAUSED', 'PAUSED_BLOCKED']) {
      const conn = new FakeConn({
        triggers: [trig('t', state)],
        fired: [{ jobGroup: 'jg', jobName: 'j', nonConcurrent: true }],
      });
      await previewThenRun(conn, RESUME);
      expect(conn.state('t')).toBe('BLOCKED');
    }
  });

  it('실행 기록이 없거나 동시 실행 허용이거나 획득만 된 행이면 WAITING (R-04, R-05, R-06)', async () => {
    const cases: FakeDb['fired'][] = [
      [],
      [{ jobGroup: 'jg', jobName: 'j', nonConcurrent: false }],
      [{ jobGroup: null, jobName: null, nonConcurrent: false }],
      [{ jobGroup: 'jg', jobName: 'other', nonConcurrent: true }],
    ];
    for (const fired of cases) {
      const conn = new FakeConn({ triggers: [trig('t', 'PAUSED_BLOCKED')], fired });
      await previewThenRun(conn, RESUME);
      expect(conn.state('t')).toBe('WAITING');
    }
  });

  it('일시정지 상태가 아니면 바꾸지 않는다 (R-07)', async () => {
    for (const state of ['WAITING', 'BLOCKED', 'ERROR', 'COMPLETE']) {
      const conn = one(state);
      const out = await previewThenRun(conn, RESUME);
      expect(out.changes).toEqual([]);
      expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE']);
      expect(conn.writes()).toEqual([]);
    }
  });

  it('NEXT_FIRE_TIME이 없으면 바꾸지 않는다 (R-08)', async () => {
    const conn = one('PAUSED', { nft: null });
    const out = await previewThenRun(conn, RESUME);
    expect(out.changes).toEqual([]);
    expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE', 'NO_NEXT_FIRE_TIME']);
    expect(conn.state('t')).toBe('PAUSED');
  });

  it('그룹이 일시정지돼 있어도 실행 시각이 남았으면 재개하고 그룹 행은 그대로 둔다 (R-09)', async () => {
    const conn = new FakeConn({ triggers: [trig('t', 'PAUSED')], pausedGroups: ['g'] });
    const preview = await previewCommand(conn, ctx, RESUME);
    expect(preview.subject.pausedGroups).toEqual(['g']);
    await executeCommand(conn, ctx, RESUME, expectedOf(preview.subject));
    expect(conn.state('t')).toBe('WAITING');
    expect(conn.committed.pausedGroups).toEqual(['g']);
  });

  it('실행 시각이 지났으면 재개하고 misfire 처리를 노드에 맡긴다고 알린다 (R-11, R-21)', async () => {
    const conn = one('PAUSED', { nft: PAST });
    const out = await previewThenRun(conn, RESUME);
    expect(conn.state('t')).toBe('WAITING');
    expect(conn.committed.triggers[0]?.nft).toBe(PAST);
    expect(out.warnings).toMatchObject([
      { code: 'MISFIRE_DELEGATED', triggers: [{ group: 'g', name: 't' }] },
    ]);
  });

  it('일시정지된 그룹 안의 지난 트리거는 거부한다 (R-31, R-32)', async () => {
    for (const pausedGroups of [['g'], [ALL_GROUPS_PAUSED]]) {
      const conn = new FakeConn({ triggers: [trig('t', 'PAUSED', { nft: PAST })], pausedGroups });
      const preview = await previewCommand(conn, ctx, RESUME);
      expect(preview.plan.rejection).toMatchObject({
        code: 'RESUME_IN_PAUSED_GROUP',
        triggers: [{ group: 'g', name: 't' }],
      });
      expect(preview.plan.changes).toEqual([]);

      const err = await rejected(executeCommand(conn, ctx, RESUME, expectedOf(preview.subject)));
      expect(err).toMatchObject({
        code: 'RESUME_IN_PAUSED_GROUP',
        current: [{ group: 'g', name: 't' }],
      });
      expect(conn.writes()).toEqual([]);
      expect(conn.calls.at(-1)?.kind).toBe('rollback');
    }
  });

  it('미리보기 뒤 그룹 일시정지가 바뀌면 STATE_CONFLICT', async () => {
    const conn = new FakeConn({ triggers: [trig('t', 'PAUSED')] });
    const err = await rejected(executeCommand(conn, ctx, RESUME, expectedOf1('PAUSED', ['g'])));
    expect(err).toMatchObject({ code: 'STATE_CONFLICT', current: expectedOf1('PAUSED') });
  });
});

describe('잡 단위 (부록 A.2 P-05, A.3 R-10·R-33)', () => {
  const job = { group: 'jg', name: 'j' };

  it('pauseJob: 잡의 트리거마다 일시정지 규칙을 적용한다 (P-05)', async () => {
    const conn = new FakeConn({
      triggers: [
        trig('t1', 'WAITING'),
        trig('t2', 'BLOCKED'),
        trig('t3', 'PAUSED'),
        trig('t4', 'ERROR'),
      ],
    });
    const out = await previewThenRun(conn, { type: 'pauseJob', job });
    expect(out.changes.map((c) => `${c.name}:${c.to}`)).toEqual(['t1:PAUSED', 't2:PAUSED_BLOCKED']);
    expect(conn.committed.triggers.map((t) => t.state)).toEqual([
      'PAUSED',
      'PAUSED_BLOCKED',
      'PAUSED',
      'ERROR',
    ]);
  });

  it('resumeJob: P는 W(실행 중인 동시 실행 금지 잡이면 B), PB는 B, E는 그대로 (R-10)', async () => {
    const conn = new FakeConn({
      triggers: [trig('t1', 'PAUSED'), trig('t2', 'PAUSED_BLOCKED'), trig('t3', 'ERROR')],
      fired: [{ jobGroup: 'jg', jobName: 'j', nonConcurrent: true }],
    });
    await previewThenRun(conn, { type: 'resumeJob', job });
    expect(conn.committed.triggers.map((t) => t.state)).toEqual(['BLOCKED', 'BLOCKED', 'ERROR']);
  });

  it('resumeJob: 하나라도 거부 대상이면 전체를 거부한다 (R-33)', async () => {
    const conn = new FakeConn({
      triggers: [trig('t1', 'PAUSED', { nft: PAST, group: 'pg' }), trig('t2', 'PAUSED')],
      pausedGroups: ['pg'],
    });
    const preview = await previewCommand(conn, ctx, { type: 'resumeJob', job });
    expect(preview.plan.rejection?.triggers).toEqual([{ group: 'pg', name: 't1' }]);
    const err = await rejected(
      executeCommand(conn, ctx, { type: 'resumeJob', job }, expectedOf(preview.subject)),
    );
    expect(err).toMatchObject({ code: 'RESUME_IN_PAUSED_GROUP' });
    expect(conn.committed.triggers.map((t) => t.state)).toEqual(['PAUSED', 'PAUSED']);
  });

  it('트리거가 없는 잡은 NO_CHANGE, 없는 잡은 NOT_FOUND', async () => {
    const empty = new FakeConn({ jobs: ['jg/j'] });
    const out = await previewThenRun(empty, { type: 'pauseJob', job });
    expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE']);

    const missing = new FakeConn({});
    await expect(previewCommand(missing, ctx, { type: 'pauseJob', job })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('트리거 그룹 (부록 A.4)', () => {
  const STATES = [
    'WAITING',
    'ACQUIRED',
    'BLOCKED',
    'PAUSED',
    'PAUSED_BLOCKED',
    'ERROR',
    'COMPLETE',
  ];

  it('pauseTriggerGroup: 그룹의 트리거를 일시정지하고 그룹 행을 넣는다 (G-01)', async () => {
    const conn = new FakeConn({
      triggers: [
        ...STATES.map((s, i) => trig(`t${i}`, s)),
        trig('other', 'WAITING', { group: 'h' }),
      ],
    });
    const out = await previewThenRun(conn, { type: 'pauseTriggerGroup', group: 'g' });
    expect(out.groupChanges).toEqual([{ group: 'g', paused: true }]);
    expect(conn.committed.triggers.map((t) => t.state)).toEqual([
      'PAUSED',
      'PAUSED',
      'PAUSED_BLOCKED',
      'PAUSED',
      'PAUSED_BLOCKED',
      'ERROR',
      'COMPLETE',
      'WAITING',
    ]);
    expect(conn.committed.pausedGroups).toEqual(['g']);
    expect(out.after.pausedGroups).toEqual(['g']);
  });

  it('트리거가 없는 그룹도 그룹 행을 넣고, 이미 있으면 다시 넣지 않는다 (G-02, G-03)', async () => {
    const empty = new FakeConn({});
    await previewThenRun(empty, { type: 'pauseTriggerGroup', group: 'g' });
    expect(empty.committed.pausedGroups).toEqual(['g']);

    const already = new FakeConn({ pausedGroups: ['g'] });
    const out = await previewThenRun(already, { type: 'pauseTriggerGroup', group: 'g' });
    expect(out.groupChanges).toEqual([]);
    expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE']);
    expect(already.writes()).toEqual([]);
  });

  it('그룹 이름은 =로 비교한다 (G-07)', async () => {
    const conn = new FakeConn({
      triggers: [trig('a', 'WAITING', { group: 'A_B' }), trig('x', 'WAITING', { group: 'AXB' })],
    });
    await previewThenRun(conn, { type: 'pauseTriggerGroup', group: 'A_B' });
    expect(conn.committed.triggers.map((t) => t.state)).toEqual(['PAUSED', 'WAITING']);
    expect(conn.committed.pausedGroups).toEqual(['A_B']);
    const select = conn.sqls('query').find((s) => s.includes('QRTZ_TRIGGERS'));
    expect(select).toContain('t.TRIGGER_GROUP = :p2');
    expect(select).not.toContain('LIKE');
  });

  it('resumeTriggerGroup: 그룹 행을 지우고 그룹의 트리거를 모두 재개한다 (G-05, G-06)', async () => {
    const conn = new FakeConn({
      triggers: [trig('t1', 'PAUSED'), trig('t2', 'PAUSED_BLOCKED'), trig('t3', 'ERROR')],
      pausedGroups: ['g'],
    });
    const out = await previewThenRun(conn, { type: 'resumeTriggerGroup', group: 'g' });
    expect(out.groupChanges).toEqual([{ group: 'g', paused: false }]);
    expect(conn.committed.triggers.map((t) => t.state)).toEqual(['WAITING', 'WAITING', 'ERROR']);
    expect(conn.committed.pausedGroups).toEqual([]);

    const individual = new FakeConn({ triggers: [trig('t1', 'PAUSED')] });
    await previewThenRun(individual, { type: 'resumeTriggerGroup', group: 'g' });
    expect(individual.state('t1')).toBe('WAITING');
  });

  it('resumeTriggerGroup: 그룹 행을 지우므로 지난 트리거도 재개한다', async () => {
    const conn = new FakeConn({
      triggers: [trig('t1', 'PAUSED', { nft: PAST })],
      pausedGroups: ['g'],
    });
    const out = await previewThenRun(conn, { type: 'resumeTriggerGroup', group: 'g' });
    expect(conn.state('t1')).toBe('WAITING');
    expect(out.warnings.map((w) => w.code)).toEqual(['MISFIRE_DELEGATED']);
  });

  it('resumeTriggerGroup: 전체 일시정지가 남아 있으면 지난 트리거가 있을 때 거부한다', async () => {
    const conn = new FakeConn({
      triggers: [trig('t1', 'PAUSED', { nft: PAST })],
      pausedGroups: ['g', ALL_GROUPS_PAUSED],
    });
    const preview = await previewCommand(conn, ctx, { type: 'resumeTriggerGroup', group: 'g' });
    expect(preview.plan.rejection?.code).toBe('RESUME_IN_PAUSED_GROUP');
    expect(preview.plan.groupChanges).toEqual([]);
  });
});

describe('잡 그룹 (부록 A.4 G-08, G-10)', () => {
  it('pauseJobGroup: 그룹의 모든 잡 트리거를 일시정지하고 그룹 행은 넣지 않는다', async () => {
    const conn = new FakeConn({
      triggers: [
        trig('t1', 'WAITING', { jobName: 'j1' }),
        trig('t2', 'WAITING', { jobName: 'j2' }),
        trig('t3', 'WAITING', { jobGroup: 'other' }),
      ],
    });
    const out = await previewThenRun(conn, { type: 'pauseJobGroup', group: 'jg' });
    expect(conn.committed.triggers.map((t) => t.state)).toEqual(['PAUSED', 'PAUSED', 'WAITING']);
    expect(conn.committed.pausedGroups).toEqual([]);
    expect(out.warnings.map((w) => w.code)).toEqual(['JOB_GROUP_NOT_STORED']);
  });

  it('resumeJobGroup: 모든 트리거를 재개한다', async () => {
    const conn = new FakeConn({
      triggers: [trig('t1', 'PAUSED', { jobName: 'j1' }), trig('t2', 'PAUSED', { jobName: 'j2' })],
    });
    await previewThenRun(conn, { type: 'resumeJobGroup', group: 'jg' });
    expect(conn.committed.triggers.map((t) => t.state)).toEqual(['WAITING', 'WAITING']);
  });

  it('잡이 하나도 없는 그룹은 NOT_FOUND', async () => {
    const conn = new FakeConn({});
    await expect(
      previewCommand(conn, ctx, { type: 'pauseJobGroup', group: 'jg' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('triggerJob (부록 A.5)', () => {
  const TRIGGER_JOB: QuartzCommand = { type: 'triggerJob', job: { group: 'jg', name: 'j' } };
  const run = (conn: FakeConn) =>
    previewCommand(conn, ctx, TRIGGER_JOB, { actor: 'kim' }).then((preview) =>
      executeCommand(conn, ctx, TRIGGER_JOB, expectedOf(preview.subject), { actor: 'kim' }),
    );

  it('DEFAULT 그룹에 반복 0회 SIMPLE 트리거를 넣는다 (T-01)', async () => {
    const conn = new FakeConn({ jobs: ['jg/j'] });
    const out = await run(conn);
    const [row] = conn.committed.inserted;
    expect(row).toMatchObject({
      SCHED_NAME: 'S',
      TRIGGER_GROUP: 'DEFAULT',
      JOB_NAME: 'j',
      JOB_GROUP: 'jg',
      DESCRIPTION: 'quartz-admin: kim',
      NEXT_FIRE_TIME: DB_NOW,
      START_TIME: DB_NOW,
      PREV_FIRE_TIME: -1,
      END_TIME: 0,
      PRIORITY: 5,
      MISFIRE_INSTR: 0,
      TRIGGER_STATE: 'WAITING',
      TRIGGER_TYPE: 'SIMPLE',
    });
    expect(row?.TRIGGER_NAME).toMatch(/^MT_[0-9a-z]+$/);
    expect(row).not.toHaveProperty('JOB_DATA');
    expect(out.inserts).toEqual([
      expect.objectContaining({ name: row?.TRIGGER_NAME, state: 'WAITING', group: 'DEFAULT' }),
    ]);
    const simple = conn.calls.find((c) =>
      c.sql?.startsWith('INSERT INTO "Q"."QRTZ_SIMPLE_TRIGGERS"'),
    );
    expect(simple?.binds).toEqual(['S', row?.TRIGGER_NAME, 'DEFAULT', 0, 0, 0]);
    expect(out.warnings).toEqual([]);
  });

  it('DEFAULT 그룹이 일시정지면 PAUSED, 전체 일시정지만 있으면 그룹 행을 넣고 PAUSED (T-02, T-03)', async () => {
    const grouped = new FakeConn({ jobs: ['jg/j'], pausedGroups: ['DEFAULT'] });
    const a = await run(grouped);
    expect(a.inserts[0]?.state).toBe('PAUSED');
    expect(a.groupChanges).toEqual([]);
    expect(a.warnings.map((w) => w.code)).toEqual(['INSERTED_PAUSED']);

    const all = new FakeConn({ jobs: ['jg/j'], pausedGroups: [ALL_GROUPS_PAUSED] });
    const b = await run(all);
    expect(b.inserts[0]?.state).toBe('PAUSED');
    expect(b.groupChanges).toEqual([{ group: 'DEFAULT', paused: true }]);
    expect(all.committed.pausedGroups.sort()).toEqual([ALL_GROUPS_PAUSED, 'DEFAULT'].sort());
  });

  it('동시 실행 금지 잡이 실행 중이면 BLOCKED, 그룹 일시정지까지면 PAUSED_BLOCKED (T-04, T-05)', async () => {
    const fired = [{ jobGroup: 'jg', jobName: 'j', nonConcurrent: true }];
    const running = await run(new FakeConn({ jobs: ['jg/j'], fired }));
    expect(running.inserts[0]?.state).toBe('BLOCKED');
    expect(running.warnings.map((w) => w.code)).toEqual(['JOB_RUNNING_NONCONCURRENT']);

    const both = await run(new FakeConn({ jobs: ['jg/j'], fired, pausedGroups: ['DEFAULT'] }));
    expect(both.inserts[0]?.state).toBe('PAUSED_BLOCKED');
  });

  it('동시 실행 허용 잡은 실행 중이어도 WAITING (T-06)', async () => {
    const out = await run(
      new FakeConn({
        jobs: ['jg/j'],
        fired: [{ jobGroup: 'jg', jobName: 'j', nonConcurrent: false }],
      }),
    );
    expect(out.inserts[0]?.state).toBe('WAITING');
  });

  it('잡이 없으면 NOT_FOUND이고 아무것도 넣지 않는다 (T-07)', async () => {
    const conn = new FakeConn({});
    await expect(previewCommand(conn, ctx, TRIGGER_JOB)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const err = await rejected(
      executeCommand(conn, ctx, TRIGGER_JOB, { triggers: [], pausedGroups: [] }),
    );
    expect(err).toMatchObject({ code: 'NOT_FOUND' });
    expect(conn.writes()).toEqual([]);
  });

  it('활성 노드가 없으면 경고한다', async () => {
    const conn = new FakeConn({
      jobs: ['jg/j'],
      nodes: [{ name: 'node-1', lastCheckin: DB_NOW - 600_000, interval: 7_500 }],
    });
    const preview = await previewCommand(conn, ctx, TRIGGER_JOB);
    expect(preview.subject.activeNodeCount).toBe(0);
    expect(preview.plan.warnings.map((w) => w.code)).toEqual(['NO_ACTIVE_NODE']);
    expect(preview.plan.inserts[0]?.name).toBeNull();
  });

  it('미리보기 뒤 DEFAULT 그룹이 일시정지되면 STATE_CONFLICT', async () => {
    const conn = new FakeConn({ jobs: ['jg/j'], pausedGroups: ['DEFAULT'] });
    const err = await rejected(
      executeCommand(conn, ctx, TRIGGER_JOB, { triggers: [], pausedGroups: [] }),
    );
    expect(err).toMatchObject({ code: 'STATE_CONFLICT' });
    expect(conn.writes()).toEqual([]);
  });

  it('이름이 겹치면 다시 만든다', async () => {
    const conn = new FakeConn({ jobs: ['jg/j'] });
    // 첫 이름 확인만 겹친다고 답한다. 가로챈 호출은 calls에 남지 않는다
    let first = true;
    const query = conn.query.bind(conn);
    conn.query = (sql, binds) => {
      if (first && sql.includes('COUNT(*)') && sql.includes('QRTZ_TRIGGERS')) {
        first = false;
        return Promise.resolve([{ C: 1 }] as never);
      }
      return query(sql, binds);
    };
    await run(conn);
    const checks = conn.calls.filter(
      (c) => c.sql?.includes('COUNT(*)') && c.sql.includes('QRTZ_TRIGGERS'),
    );
    expect(checks).toHaveLength(1);
    expect(conn.committed.inserted).toHaveLength(1);
  });
});

describe('스케줄 수정 (부록 A.6)', () => {
  /** DB_NOW(2025-11-06 03:33:20Z) 다음 12:00 UTC */
  const NEXT_NOON = Date.UTC(2025, 10, 6, 12);
  const DAY = 86_400_000;
  const cronTrig = (state: string, more: Partial<FakeTrigger> = {}) =>
    trig('t', state, {
      type: 'CRON',
      cron: { expression: '0 0 6 * * ?', timeZone: 'Asia/Seoul' },
      ...more,
    });
  const CRON: QuartzCommand = {
    type: 'updateCronSchedule',
    trigger: { group: 'g', name: 't' },
    cronExpression: '0 0 12 * * ?',
    timeZone: 'UTC',
  };
  const simpleCmd = (
    more: Partial<{ repeatIntervalMs: number; repeatCount: number; startAt: number }>,
  ) =>
    ({
      type: 'updateSimpleSchedule',
      trigger: { group: 'g', name: 't' },
      repeatIntervalMs: 5_000,
      repeatCount: 3,
      ...more,
    }) as QuartzCommand;

  it('C-01 CRON: 식·타임존을 바꾸고 다음 실행 시각을 다시 계산한다. 상태는 WAITING', async () => {
    const conn = new FakeConn({ triggers: [cronTrig('WAITING')] });
    const out = await previewThenRun(conn, CRON);
    const [t] = conn.committed.triggers;
    expect(t?.cron).toEqual({ expression: '0 0 12 * * ?', timeZone: 'UTC' });
    expect(t?.nft).toBe(NEXT_NOON);
    expect(t?.state).toBe('WAITING');
    expect(out.changes).toEqual([]);
    expect(out.scheduleChanges[0]).toMatchObject({
      from: { kind: 'CRON', cronExpression: '0 0 6 * * ?', timeZone: 'Asia/Seoul' },
      to: {
        kind: 'CRON',
        cronExpression: '0 0 12 * * ?',
        timeZone: 'UTC',
        nextFireTime: NEXT_NOON,
      },
      upcoming: [0, 1, 2, 3, 4].map((i) => NEXT_NOON + i * DAY),
    });
    // START_TIME은 바꾸지 않는다
    expect(conn.sqls('execute').find((q) => q.includes('SET NEXT_FIRE_TIME'))).not.toContain(
      'START_TIME',
    );
  });

  it('식은 Quartz처럼 대문자로 저장한다', async () => {
    const conn = new FakeConn({ triggers: [cronTrig('WAITING')] });
    await previewThenRun(conn, { ...CRON, cronExpression: '0 0 12 ? * mon-fri' });
    expect(conn.committed.triggers[0]?.cron?.expression).toBe('0 0 12 ? * MON-FRI');
  });

  it('C-02·C-03 개별 일시정지는 유지한다. PAUSED_BLOCKED는 잡이 실행 중이면 그대로, 아니면 PAUSED', async () => {
    const paused = new FakeConn({ triggers: [cronTrig('PAUSED')] });
    const a = await previewThenRun(paused, CRON);
    expect(paused.state('t')).toBe('PAUSED');
    expect(a.warnings.map((w) => w.code)).toEqual(['PAUSE_KEPT']);

    const fired = [{ jobGroup: 'jg', jobName: 'j', nonConcurrent: true }];
    const running = new FakeConn({ triggers: [cronTrig('PAUSED_BLOCKED')], fired });
    await previewThenRun(running, CRON);
    expect(running.state('t')).toBe('PAUSED_BLOCKED');

    const idle = new FakeConn({ triggers: [cronTrig('PAUSED_BLOCKED')] });
    const c = await previewThenRun(idle, CRON);
    expect(idle.state('t')).toBe('PAUSED');
    expect(c.changes).toEqual([{ group: 'g', name: 't', from: 'PAUSED_BLOCKED', to: 'PAUSED' }]);
  });

  it('C-04·C-05·C-06 BLOCKED(실행 중)는 그대로, ACQUIRED와 ERROR는 WAITING', async () => {
    const blocked = new FakeConn({
      triggers: [cronTrig('BLOCKED')],
      fired: [{ jobGroup: 'jg', jobName: 'j', nonConcurrent: true }],
    });
    await previewThenRun(blocked, CRON);
    expect(blocked.state('t')).toBe('BLOCKED');

    const acquired = new FakeConn({ triggers: [cronTrig('ACQUIRED')] });
    const a = await previewThenRun(acquired, CRON);
    expect(acquired.state('t')).toBe('WAITING');
    expect(acquired.committed.triggers[0]?.nft).toBe(NEXT_NOON);
    expect(a.changes).toEqual([{ group: 'g', name: 't', from: 'ACQUIRED', to: 'WAITING' }]);
    // 스케줄 UPDATE는 바꾸기 전 상태(ACQUIRED)를 조건으로, 그 뒤 상태를 바꾼다
    const writes = acquired.writes();
    expect(writes.findIndex((q) => q.includes('SET NEXT_FIRE_TIME'))).toBeLessThan(
      writes.findIndex((q) => q.includes('SET TRIGGER_STATE')),
    );

    const error = new FakeConn({ triggers: [cronTrig('ERROR')] });
    const e = await previewThenRun(error, CRON);
    expect(error.state('t')).toBe('WAITING');
    expect(e.warnings.map((w) => w.code)).toEqual(['ERROR_CLEARED']);
  });

  it('C-07·C-08 그룹이 일시정지면 PAUSED, 전체 일시정지만 있으면 그룹 행을 넣고 PAUSED', async () => {
    const grouped = new FakeConn({ triggers: [cronTrig('WAITING')], pausedGroups: ['g'] });
    await previewThenRun(grouped, CRON);
    expect(grouped.state('t')).toBe('PAUSED');

    const all = new FakeConn({
      triggers: [cronTrig('WAITING')],
      pausedGroups: [ALL_GROUPS_PAUSED],
    });
    const out = await previewThenRun(all, CRON);
    expect(all.state('t')).toBe('PAUSED');
    expect(out.groupChanges).toEqual([{ group: 'g', paused: true }]);
  });

  it('C-09·C-10 COMPLETE와 캘린더 연결 트리거는 거부하고 바꾸지 않는다', async () => {
    for (const [conn, code] of [
      [new FakeConn({ triggers: [cronTrig('COMPLETE')] }), 'TRIGGER_COMPLETE'],
      [
        new FakeConn({ triggers: [cronTrig('WAITING', { calendar: 'holidays' })] }),
        'CALENDAR_ATTACHED',
      ],
    ] as const) {
      const preview = await previewCommand(conn, ctx, CRON);
      expect(preview.plan.rejection?.code).toBe(code);
      const err = await rejected(executeCommand(conn, ctx, CRON, expectedOf(preview.subject)));
      expect(err).toMatchObject({ code });
      expect(conn.writes()).toEqual([]);
    }
  });

  it('C-11 종료 시각이 지나 더 발화하지 않으면 INVALID_SCHEDULE', async () => {
    const conn = new FakeConn({ triggers: [cronTrig('WAITING', { endTime: DB_NOW - 1_000 })] });
    const preview = await previewCommand(conn, ctx, CRON);
    expect(preview.plan.rejection?.code).toBe('INVALID_SCHEDULE');
  });

  it('C-12 시작 시각이 미래면 다음 실행 시각은 시작 시각 이후', async () => {
    const start = DB_NOW + 2 * DAY;
    const conn = new FakeConn({ triggers: [cronTrig('WAITING', { startTime: start })] });
    await previewThenRun(conn, CRON);
    expect(conn.committed.triggers[0]?.nft).toBe(NEXT_NOON + 2 * DAY);
  });

  it('잘못된 식·타임존, 종류가 다른 트리거는 거부한다', async () => {
    const conn = new FakeConn({ triggers: [cronTrig('WAITING')] });
    for (const [command, code] of [
      [{ ...CRON, cronExpression: '0 0 25 * * ?' }, 'INVALID_SCHEDULE'],
      [{ ...CRON, timeZone: 'Mars/Olympus' }, 'INVALID_SCHEDULE'],
      [simpleCmd({}), 'TRIGGER_TYPE_MISMATCH'],
    ] as const) {
      const preview = await previewCommand(conn, ctx, command);
      expect(preview.plan.rejection?.code).toBe(code);
    }
  });

  it('C-14·S-08 집힌 트리거를 옛 발화 시각 직후(35초 안)로 고치면 TRIGGER_ACQUIRED, 그 밖이면 실행한다', async () => {
    // 옛 발화 시각 F = FUTURE(DB_NOW + 60초)
    const everySecond = { ...CRON, cronExpression: '* * * * * ?' } as QuartzCommand;
    const cases: [FakeConn, QuartzCommand][] = [
      [new FakeConn({ triggers: [cronTrig('ACQUIRED')] }), everySecond],
      [
        new FakeConn({ triggers: [trig('t', 'ACQUIRED')] }),
        simpleCmd({ startAt: FUTURE + 10_000, repeatCount: 0 }),
      ],
      // F보다 먼저 시작해도 F 직후에 다음 실행이 있으면 경합이다
      [
        new FakeConn({ triggers: [trig('t', 'ACQUIRED')] }),
        simpleCmd({ repeatIntervalMs: 20_000, repeatCount: -1 }),
      ],
    ];
    for (const [conn, command] of cases) {
      const preview = await previewCommand(conn, ctx, command);
      expect(preview.plan.rejection?.code).toBe('TRIGGER_ACQUIRED');
      const err = await rejected(executeCommand(conn, ctx, command, expectedOf(preview.subject)));
      expect(err).toMatchObject({ code: 'TRIGGER_ACQUIRED' });
      expect(conn.writes()).toEqual([]);
      expect(conn.state('t')).toBe('ACQUIRED');
    }

    // 35초 밖이면 실행하고 WAITING으로 바꾼다
    const later = new FakeConn({ triggers: [trig('t', 'ACQUIRED')] });
    await previewThenRun(later, simpleCmd({ startAt: FUTURE + 40_000, repeatCount: 0 }));
    expect(later.state('t')).toBe('WAITING');

    // 집히지 않은 트리거는 같은 시각이어도 경합이 없다
    const waiting = new FakeConn({ triggers: [cronTrig('WAITING')] });
    const out = await previewThenRun(waiting, everySecond);
    expect(out.scheduleChanges).toHaveLength(1);
  });

  it('S-01·S-02 SIMPLE: 간격·횟수를 바꾸고 횟수를 0으로, START = NFT = startAt(기본 지금)', async () => {
    const now = new FakeConn({ triggers: [trig('t', 'WAITING')] });
    const out = await previewThenRun(now, simpleCmd({}));
    const [t] = now.committed.triggers;
    expect(t?.simple).toEqual({ repeatCount: 3, repeatInterval: 5_000, timesTriggered: 0 });
    expect(t).toMatchObject({ startTime: DB_NOW, nft: DB_NOW, state: 'WAITING' });
    expect(out.scheduleChanges[0]?.upcoming).toEqual([0, 1, 2, 3].map((i) => DB_NOW + i * 5_000));

    const later = new FakeConn({ triggers: [trig('t', 'WAITING')] });
    await previewThenRun(later, simpleCmd({ startAt: DB_NOW + 3_600_000 }));
    expect(later.committed.triggers[0]).toMatchObject({
      startTime: DB_NOW + 3_600_000,
      nft: DB_NOW + 3_600_000,
    });
  });

  it('S-03·S-04·S-05 지난 시작 시각, 반복하는데 간격 0, 종료 시각보다 늦은 시작은 거부한다', async () => {
    const cases: [FakeConn, QuartzCommand][] = [
      [new FakeConn({ triggers: [trig('t', 'WAITING')] }), simpleCmd({ startAt: DB_NOW - 60_000 })],
      [new FakeConn({ triggers: [trig('t', 'WAITING')] }), simpleCmd({ repeatIntervalMs: 0 })],
      [
        new FakeConn({ triggers: [trig('t', 'WAITING', { endTime: DB_NOW + 60_000 })] }),
        simpleCmd({ startAt: DB_NOW + 120_000 }),
      ],
    ];
    for (const [conn, command] of cases) {
      const preview = await previewCommand(conn, ctx, command);
      expect(preview.plan.rejection?.code).toBe('INVALID_SCHEDULE');
      const err = await rejected(executeCommand(conn, ctx, command, expectedOf(preview.subject)));
      expect(err).toMatchObject({ code: 'INVALID_SCHEDULE' });
      expect(conn.writes()).toEqual([]);
    }
  });

  it('S-06·S-07 PAUSED는 유지하고 ACQUIRED는 WAITING', async () => {
    const paused = new FakeConn({ triggers: [trig('t', 'PAUSED')] });
    await previewThenRun(paused, simpleCmd({}));
    expect(paused.state('t')).toBe('PAUSED');

    const acquired = new FakeConn({ triggers: [trig('t', 'ACQUIRED')] });
    await previewThenRun(acquired, simpleCmd({}));
    expect(acquired.state('t')).toBe('WAITING');
  });
});

describe('삭제 (부록 A.7)', () => {
  const DEL: QuartzCommand = { type: 'deleteTrigger', trigger: { group: 'g', name: 't' } };
  const DEL_JOB: QuartzCommand = { type: 'deleteJob', job: { group: 'jg', name: 'j' } };
  const childDeletes = (conn: FakeConn) =>
    conn
      .writes()
      .filter((q) => /DELETE FROM "Q"\."QRTZ_(SIMPLE|CRON|SIMPROP|BLOB)_TRIGGERS"/.test(q));

  it('D-01 durable 잡의 유일한 트리거: 트리거와 하위 행만 지우고 잡은 남긴다', async () => {
    const conn = new FakeConn({ triggers: [trig('t', 'WAITING', { type: 'CRON' })] });
    const out = await previewThenRun(conn, DEL);
    expect(out.deletions).toEqual({ triggers: [{ group: 'g', name: 't' }], jobs: [] });
    expect(conn.committed.triggers).toEqual([]);
    expect(conn.committed.jobs).toEqual(['jg/j']);
    // 하위 테이블은 모두 지워 본다(트리거 하나에 하위 행은 하나)
    expect(childDeletes(conn)).toHaveLength(3);
    expect(out.after.triggers).toEqual([]);
    expect(out.snapshot).toMatchObject({ trigger: { group: 'g', name: 't', type: 'CRON' } });
    expect(out.snapshot).not.toHaveProperty('job');
  });

  it('D-02·D-03 durable이 아닌 잡은 마지막 트리거를 지울 때만 잡도 지우고 미리 알린다', async () => {
    const last = new FakeConn({ triggers: [trig('t', 'WAITING')], nonDurable: ['jg/j'] });
    const preview = await previewCommand(last, ctx, DEL);
    expect(preview.plan.warnings.map((w) => w.code)).toEqual(['JOB_ALSO_DELETED']);
    const out = await executeCommand(last, ctx, DEL, expectedOf(preview.subject));
    expect(out.deletions.jobs).toEqual([{ group: 'jg', name: 'j' }]);
    expect(last.committed.jobs).toEqual([]);
    expect(out.snapshot).toMatchObject({
      trigger: { name: 't' },
      job: { group: 'jg', name: 'j', durable: false },
      jobData: Buffer.from('k=v').toString('base64'),
      jobDataBytes: 3,
    });

    const notLast = new FakeConn({
      triggers: [trig('t', 'WAITING'), trig('t2', 'WAITING')],
      nonDurable: ['jg/j'],
    });
    const out2 = await previewThenRun(notLast, DEL);
    expect(out2.deletions.jobs).toEqual([]);
    expect(notLast.committed.jobs).toEqual(['jg/j']);
    expect(notLast.committed.triggers.map((t) => t.name)).toEqual(['t2']);
  });

  it('D-06 실행 중인 트리거는 지우되 경고하고 FIRED_TRIGGERS는 건드리지 않는다', async () => {
    const conn = new FakeConn({
      triggers: [trig('t', 'BLOCKED')],
      fired: [
        { jobGroup: 'jg', jobName: 'j', nonConcurrent: true, trigger: { group: 'g', name: 't' } },
      ],
    });
    const out = await previewThenRun(conn, DEL);
    expect(out.warnings.map((w) => w.code)).toEqual(['DELETING_EXECUTING']);
    expect(conn.writes().some((q) => q.includes('QRTZ_FIRED_TRIGGERS'))).toBe(false);
    expect(conn.committed.fired).toHaveLength(1);
  });

  it('D-07 그룹의 마지막 트리거를 지워도 그룹 일시정지 행은 남는다', async () => {
    const conn = new FakeConn({ triggers: [trig('t', 'PAUSED')], pausedGroups: ['g'] });
    await previewThenRun(conn, DEL);
    expect(conn.committed.pausedGroups).toEqual(['g']);
    expect(conn.writes().some((q) => q.includes('PAUSED_TRIGGER_GRPS'))).toBe(false);
  });

  it('DJ-01·DJ-03 잡 삭제: 모든 트리거와 하위 행, 잡을 지운다. 트리거 없는 잡도 지운다', async () => {
    const conn = new FakeConn({
      triggers: [trig('t1', 'WAITING', { type: 'CRON' }), trig('t2', 'PAUSED')],
    });
    const out = await previewThenRun(conn, DEL_JOB);
    expect(out.deletions).toEqual({
      triggers: [
        { group: 'g', name: 't1' },
        { group: 'g', name: 't2' },
      ],
      jobs: [{ group: 'jg', name: 'j' }],
    });
    expect(conn.committed.triggers).toEqual([]);
    expect(conn.committed.jobs).toEqual([]);
    expect(out.snapshot).toMatchObject({
      job: { name: 'j' },
      triggers: [{ name: 't1' }, { name: 't2' }],
    });

    const empty = new FakeConn({ jobs: ['jg/j'] });
    await previewThenRun(empty, DEL_JOB);
    expect(empty.committed.jobs).toEqual([]);
  });

  it('DJ-02 실행 중인 잡은 경고한다. 없는 트리거·잡은 NOT_FOUND', async () => {
    const conn = new FakeConn({
      triggers: [trig('t', 'BLOCKED')],
      fired: [
        {
          jobGroup: 'jg',
          jobName: 'j',
          nonConcurrent: true,
          trigger: { group: 'g', name: 'other' },
        },
      ],
    });
    const out = await previewThenRun(conn, DEL_JOB);
    expect(out.warnings.map((w) => w.code)).toEqual(['DELETING_EXECUTING']);

    const missing = new FakeConn({});
    await expect(previewCommand(missing, ctx, DEL)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(previewCommand(missing, ctx, DEL_JOB)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('미리보기 뒤 잡에 트리거가 늘면 STATE_CONFLICT로 지우지 않는다', async () => {
    const conn = new FakeConn({ triggers: [trig('t1', 'WAITING'), trig('t2', 'WAITING')] });
    const err = await rejected(
      executeCommand(conn, ctx, DEL_JOB, {
        triggers: [{ group: 'g', name: 't1', state: 'WAITING' }],
        pausedGroups: [],
      }),
    );
    expect(err).toMatchObject({ code: 'STATE_CONFLICT' });
    expect(conn.writes()).toEqual([]);
  });
});

describe('newTriggerName', () => {
  it('Quartz와 같은 MT_ 형식이고 30~36진법이다', () => {
    for (let i = 0; i < 7; i++) {
      const name = newTriggerName(i);
      expect(name).toMatch(/^MT_[0-9a-z]+$/);
    }
    expect(new Set(Array.from({ length: 50 }, () => newTriggerName())).size).toBe(50);
  });
});

describe('previewCommand', () => {
  it('잠금 없이 읽고 바뀔 상태를 계산한다', async () => {
    const conn = one('WAITING');
    const preview = await previewCommand(conn, ctx, PAUSE);
    expect(preview).toEqual({
      dbNow: DB_NOW,
      subject: {
        triggers: [
          {
            group: 'g',
            name: 't',
            jobGroup: 'jg',
            jobName: 'j',
            state: 'WAITING',
            nextFireTime: FUTURE,
          },
        ],
        pausedGroups: [],
        blockingJobs: new Set(),
      },
      plan: {
        changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
        groupChanges: [],
        inserts: [],
        scheduleChanges: [],
        warnings: [],
        rejection: null,
      },
    });
    expect(conn.sqls('query').some((s) => s.includes('FOR UPDATE') || s.includes('LOCKS'))).toBe(
      false,
    );
    expect(conn.calls.some((c) => c.kind !== 'query')).toBe(false);
  });
});
