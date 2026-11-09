import type { QuartzCommand } from '@qa/shared';
import { describe, expect, it } from 'vitest';
import type { BindValue, Row, TargetConn } from '../adapter.js';
import { TargetError } from '../errors.js';
import { oracleDialect } from '../oracle/dialect.js';
import { QUARTZ_REQUIRED_TABLES } from '../quartz-tables.js';
import { createTableSet } from '../table-set.js';
import { CommandRejection, executeCommand, previewCommand, sameTargets } from './index.js';
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
const PAUSE: QuartzCommand = { type: 'pauseTrigger', trigger: { group: 'g', name: 't' } };

interface Call {
  kind: 'query' | 'execute' | 'commit' | 'rollback';
  sql?: string;
  binds?: readonly BindValue[];
}

/**
 * SQL 모양에 따라 답하는 가짜 커넥션. `state`는 TRIGGERS 행의 현재 상태이고 UPDATE가 바꾼다.
 * 커밋하지 않고 되돌리면 처음 상태로 돌아간다.
 */
class FakeConn implements TargetConn {
  readonly kind = 'oracle' as const;
  readonly calls: Call[] = [];
  inTransaction = false;
  committed: string | null;
  private pending: string | null;

  constructor(
    state: string | null,
    private readonly opts: {
      lockRow?: boolean;
      lockError?: TargetError;
      /** 첫 INSERT가 키 중복으로 실패한 뒤에는 행이 생긴다 */
      insertDuplicate?: boolean;
      /** UPDATE가 0행을 돌려준다(잠금을 거치지 않은 쓰기를 흉내 낸다) */
      updateMisses?: boolean;
    } = {},
  ) {
    this.committed = state;
    this.pending = state;
  }

  query<R extends Row = Row>(sql: string, binds: readonly BindValue[] = []): Promise<R[]> {
    this.calls.push({ kind: 'query', sql, binds });
    if (this.opts.lockError && sql.includes('QRTZ_LOCKS'))
      return Promise.reject(this.opts.lockError);
    return Promise.resolve(this.answer(sql) as R[]);
  }

  private answer(sql: string): Row[] {
    if (sql.includes('SYSTIMESTAMP')) return [{ NOW_MS: DB_NOW }];
    if (sql.includes('QRTZ_LOCKS'))
      return this.opts.lockRow === false ? [] : [{ L: 'TRIGGER_ACCESS' }];
    if (sql.includes('QRTZ_TRIGGERS')) {
      return this.pending === null ? [] : [{ G: 'g', N: 't', JG: 'jg', JN: 'j', ST: this.pending }];
    }
    throw new Error(`예상하지 못한 SQL: ${sql}`);
  }

  execute(sql: string, binds: readonly BindValue[] = []): Promise<number> {
    this.calls.push({ kind: 'execute', sql, binds });
    this.inTransaction = true;
    if (sql.startsWith('INSERT INTO "Q"."QRTZ_LOCKS"')) {
      if (this.opts.insertDuplicate) {
        this.opts.insertDuplicate = false;
        this.opts.lockRow = true;
        return Promise.reject(new TargetError('TARGET_ERROR', { driverCode: 'ORA-00001' }));
      }
      return Promise.resolve(1);
    }
    if (sql.startsWith('UPDATE "Q"."QRTZ_TRIGGERS"')) {
      if (this.opts.updateMisses) return Promise.resolve(0);
      const [to, , , , from] = binds;
      if (this.pending !== from) return Promise.resolve(0);
      this.pending = to as string;
      return Promise.resolve(1);
    }
    return Promise.reject(new Error(`예상하지 못한 SQL: ${sql}`));
  }

  commit(): Promise<void> {
    this.calls.push({ kind: 'commit' });
    this.committed = this.pending;
    this.inTransaction = false;
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.calls.push({ kind: 'rollback' });
    this.pending = this.committed;
    this.inTransaction = false;
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  sqls(kind: Call['kind']): string[] {
    return this.calls.filter((c) => c.kind === kind).map((c) => c.sql ?? '');
  }
}

const expectedOf = (state: string) => [{ group: 'g', name: 't', state }];

describe('sameTargets (FR-CTL-00e)', () => {
  it('Quartz getTriggerState 분류로 비교한다. WAITING과 ACQUIRED, PAUSED와 PAUSED_BLOCKED는 같다', () => {
    expect(sameTargets(expectedOf('WAITING'), expectedOf('ACQUIRED'))).toBe(true);
    expect(sameTargets(expectedOf('PAUSED'), expectedOf('PAUSED_BLOCKED'))).toBe(true);
    expect(sameTargets(expectedOf('WAITING'), expectedOf('PAUSED'))).toBe(false);
    expect(sameTargets(expectedOf('WAITING'), expectedOf('BLOCKED'))).toBe(false);
  });

  it('대상 집합이 다르면 다르다. 순서는 보지 않는다', () => {
    const a = { group: 'g', name: 'a', state: 'WAITING' };
    const b = { group: 'g', name: 'b', state: 'PAUSED' };
    expect(sameTargets([a, b], [b, a])).toBe(true);
    expect(sameTargets([a], [a, b])).toBe(false);
    expect(sameTargets([a, a], [a, b])).toBe(false);
    expect(sameTargets([a], [{ ...a, group: 'h' }])).toBe(false);
  });
});

describe('executeCommand (TRD §7.1)', () => {
  it('잠금 행 → 대상 행 순서로 잠그고, 조건부 UPDATE 뒤 다시 읽어 커밋한다', async () => {
    const conn = new FakeConn('WAITING');
    const out = await executeCommand(conn, ctx, PAUSE, expectedOf('WAITING'));

    expect(out).toMatchObject({
      dbNow: DB_NOW,
      lock: 'locked',
      changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
      warnings: [],
    });
    expect(out.before[0]?.state).toBe('WAITING');
    expect(out.after[0]?.state).toBe('PAUSED');
    expect(conn.committed).toBe('PAUSED');

    const queries = conn.sqls('query');
    expect(queries[0]).toMatch(/FROM "Q"\."QRTZ_LOCKS" .*LOCK_NAME = :p2 FOR UPDATE WAIT 5$/);
    expect(conn.calls[0]?.binds).toEqual(['S', 'TRIGGER_ACCESS']);
    expect(queries[2]).toMatch(/FROM "Q"\."QRTZ_TRIGGERS" t .* FOR UPDATE WAIT 5$/);
    // 변경 후 조회는 이미 잠근 행이라 다시 잠그지 않는다
    expect(queries[3]).not.toContain('FOR UPDATE');
    const [update] = conn.calls.filter((c) => c.kind === 'execute');
    expect(update?.sql).toContain('AND TRIGGER_STATE = :p5');
    expect(update?.binds).toEqual(['PAUSED', 'S', 'g', 't', 'WAITING']);
    expect(conn.calls.at(-1)?.kind).toBe('commit');
  });

  it('BLOCKED는 PAUSED_BLOCKED로, 화면에서 본 WAITING이 ACQUIRED가 됐어도 실행한다', async () => {
    const blocked = new FakeConn('BLOCKED');
    const out = await executeCommand(blocked, ctx, PAUSE, expectedOf('BLOCKED'));
    expect(out.changes).toEqual([{ group: 'g', name: 't', from: 'BLOCKED', to: 'PAUSED_BLOCKED' }]);

    const acquired = new FakeConn('ACQUIRED');
    await executeCommand(acquired, ctx, PAUSE, expectedOf('WAITING'));
    expect(acquired.committed).toBe('PAUSED');
  });

  it('바뀌는 것이 없으면 UPDATE 없이 커밋하고 NO_CHANGE를 알린다 (P-04)', async () => {
    for (const state of ['PAUSED', 'PAUSED_BLOCKED', 'ERROR', 'COMPLETE']) {
      const conn = new FakeConn(state);
      const out = await executeCommand(conn, ctx, PAUSE, expectedOf(state));
      expect(out.changes).toEqual([]);
      expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE']);
      expect(conn.sqls('execute')).toEqual([]);
      expect(conn.committed).toBe(state);
    }
  });

  it('잠금 행이 없으면 넣고 그 트랜잭션에서 계속한다 (X-02)', async () => {
    const conn = new FakeConn('WAITING', { lockRow: false });
    const out = await executeCommand(conn, ctx, PAUSE, expectedOf('WAITING'));
    expect(out.lock).toBe('inserted');
    expect(conn.sqls('execute')[0]).toBe(
      'INSERT INTO "Q"."QRTZ_LOCKS" (SCHED_NAME, LOCK_NAME) VALUES (:p1, :p2)',
    );
    expect(conn.committed).toBe('PAUSED');
  });

  it('잠금 행 INSERT가 키 중복이면 되돌리고 한 번 다시 잠근다', async () => {
    const conn = new FakeConn('WAITING', { lockRow: false, insertDuplicate: true });
    const out = await executeCommand(conn, ctx, PAUSE, expectedOf('WAITING'));
    expect(out.lock).toBe('locked');
    expect(conn.calls.map((c) => c.kind).slice(0, 4)).toEqual([
      'query',
      'execute',
      'rollback',
      'query',
    ]);
    expect(conn.committed).toBe('PAUSED');
  });

  it('기대 상태와 다르면 바꾸지 않고 되돌리며 최신 상태를 돌려준다 (X-04)', async () => {
    const conn = new FakeConn('PAUSED');
    const err: unknown = await executeCommand(conn, ctx, PAUSE, expectedOf('WAITING')).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandRejection);
    expect(err).toMatchObject({ code: 'STATE_CONFLICT', current: expectedOf('PAUSED') });
    expect(conn.sqls('execute')).toEqual([]);
    expect(conn.calls.at(-1)?.kind).toBe('rollback');
  });

  it('잠금 대기 초과는 LOCK_TIMEOUT 그대로 던지고 되돌린다 (X-01)', async () => {
    const conn = new FakeConn('WAITING', {
      lockError: new TargetError('LOCK_TIMEOUT', { driverCode: 'ORA-30006' }),
    });
    await expect(executeCommand(conn, ctx, PAUSE, expectedOf('WAITING'))).rejects.toMatchObject({
      code: 'LOCK_TIMEOUT',
    });
    expect(conn.calls.map((c) => c.kind)).toEqual(['query', 'rollback']);
    expect(conn.committed).toBe('WAITING');
  });

  it('조건부 UPDATE가 계획보다 적게 바뀌면 되돌린다', async () => {
    const conn = new FakeConn('WAITING', { updateMisses: true });
    await expect(executeCommand(conn, ctx, PAUSE, expectedOf('WAITING'))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(conn.sqls('commit')).toEqual([]);
    expect(conn.calls.at(-1)?.kind).toBe('rollback');
  });

  it('대상이 없으면 NOT_FOUND', async () => {
    const conn = new FakeConn(null);
    await expect(executeCommand(conn, ctx, PAUSE, expectedOf('WAITING'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(conn.calls.at(-1)?.kind).toBe('rollback');
  });
});

describe('previewCommand', () => {
  it('잠금 없이 읽고 바뀔 상태를 계산한다', async () => {
    const conn = new FakeConn('WAITING');
    const preview = await previewCommand(conn, ctx, PAUSE);
    expect(preview).toEqual({
      dbNow: DB_NOW,
      targets: [{ group: 'g', name: 't', jobGroup: 'jg', jobName: 'j', state: 'WAITING' }],
      changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
      warnings: [],
    });
    expect(conn.sqls('query').some((s) => s.includes('FOR UPDATE') || s.includes('LOCKS'))).toBe(
      false,
    );
    expect(conn.calls.some((c) => c.kind !== 'query')).toBe(false);
  });
});
