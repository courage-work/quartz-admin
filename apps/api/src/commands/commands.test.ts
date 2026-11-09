import type {
  AuditLogPage,
  CommandPreviewResponse,
  CommandResultDto,
  QuartzCommand,
} from '@qa/shared';
import {
  TargetError,
  TargetPoolManager,
  type BindValue,
  type DriverAdapter,
  type QuartzDetection,
  type Row,
  type TargetConn,
} from '@qa/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp } from '../auth/test-support.js';
import { QUARTZ_DETECTOR, type QuartzDetector } from '../targets/targets.service.js';
import { KeyedMutex } from './keyed-mutex.js';

describe('KeyedMutex', () => {
  it('같은 키는 하나씩, 다른 키는 동시에 실행하고 앞 작업이 실패해도 다음 작업을 실행한다', async () => {
    const mutex = new KeyedMutex<number>();
    const log: string[] = [];
    const step =
      (name: string, ms: number, fail = false) =>
      async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}:end`);
        if (fail) throw new Error(name);
        return name;
      };
    const a = mutex.run(1, step('a', 20, true));
    const b = mutex.run(1, step('b', 1));
    const c = mutex.run(2, step('c', 1));
    await expect(a).rejects.toThrow('a');
    await expect(b).resolves.toBe('b');
    await expect(c).resolves.toBe('c');
    expect(log.indexOf('b:start')).toBeGreaterThan(log.indexOf('a:end'));
    expect(log.indexOf('c:start')).toBeLessThan(log.indexOf('a:end'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mutex.size).toBe(0);
  });
});

// ── API ─────────────────────────────────────────────────

const DB_NOW = 1_762_400_000_000;
const TABLES = [
  'JOB_DETAILS',
  'TRIGGERS',
  'SIMPLE_TRIGGERS',
  'CRON_TRIGGERS',
  'BLOB_TRIGGERS',
  'CALENDARS',
  'PAUSED_TRIGGER_GRPS',
  'FIRED_TRIGGERS',
  'SCHEDULER_STATE',
  'LOCKS',
];

/**
 * 트리거 하나를 가진 가짜 Oracle 대상. UPDATE가 상태를 바꾸고, 커밋하지 않고 되돌리면 원래대로 돌아간다.
 * 잠금 행을 잡은 트랜잭션 수를 세어 직렬화를 확인한다.
 */
class FakeTarget {
  committed: string | null = 'WAITING';
  writes = 0;
  lockDelayMs = 0;
  lockError: TargetError | undefined;
  inLock = 0;
  maxInLock = 0;

  readonly adapter: DriverAdapter = {
    kind: 'oracle',
    connect: () => Promise.resolve(this.conn()),
  };

  private conn(): TargetConn {
    // 커밋하지 않은 변경. 없으면 커밋된 값을 읽는다(풀이 커넥션을 다시 써도 테스트가 바꾼 값을 본다)
    let dirty: { state: string | null } | null = null;
    const current = () => (dirty ? dirty.state : this.committed);
    let locked = false;
    const release = () => {
      if (locked) this.inLock--;
      locked = false;
    };
    const conn: TargetConn = {
      kind: 'oracle',
      inTransaction: false,
      query: async <R extends Row = Row>(sql: string): Promise<R[]> => {
        if (sql.includes('SYSTIMESTAMP')) return [{ NOW_MS: DB_NOW }] as Row[] as R[];
        if (sql.includes('QRTZ_LOCKS')) {
          if (this.lockError) throw this.lockError;
          if (!locked) {
            locked = true;
            this.inLock++;
            this.maxInLock = Math.max(this.maxInLock, this.inLock);
          }
          await new Promise((r) => setTimeout(r, this.lockDelayMs));
          return [{ L: 'TRIGGER_ACCESS' }] as Row[] as R[];
        }
        if (sql.includes('QRTZ_TRIGGERS')) {
          const state = current();
          const rows: Row[] =
            state === null ? [] : [{ G: 'g', N: 't', JG: 'jg', JN: 'j', ST: state }];
          return rows as R[];
        }
        throw new Error(`예상하지 못한 SQL: ${sql}`);
      },
      execute: (_sql: string, binds: readonly BindValue[] = []) => {
        this.writes++;
        const [to, , , , from] = binds;
        if (current() !== from) return Promise.resolve(0);
        dirty = { state: to as string };
        return Promise.resolve(1);
      },
      commit: () => {
        if (dirty) this.committed = dirty.state;
        dirty = null;
        release();
        return Promise.resolve();
      },
      rollback: () => {
        dirty = null;
        release();
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    return conn;
  }
}

const PAUSE: QuartzCommand = { type: 'pauseTrigger', trigger: { group: 'g', name: 't' } };

describe('제어 명령 API (TRD §7.1)', () => {
  let t: TestApp;
  let fake: FakeTarget;
  let cookie: string;

  /** 접속과 스케줄러를 등록하고 감지로 쓰기 권한을 확인한다 */
  async function register(name: string, readOnly = false): Promise<number> {
    const conn = await t
      .send(
        'post',
        '/connections',
        {
          name,
          dbType: 'oracle',
          host: 'db',
          port: 1521,
          oracleServiceName: 'PDB',
          username: 'u',
          password: 'p',
          envLabel: 'prod',
          readOnly,
        },
        cookie,
      )
      .expect(201);
    const connectionId = (conn.body as { id: number }).id;
    await t.send('post', `/connections/${connectionId}/detect`, {}, cookie).expect(200);
    const reg = await t
      .send(
        'post',
        `/connections/${connectionId}/schedulers`,
        { selections: [{ prefix: 'QRTZ_', schedName: 'S' }] },
        cookie,
      )
      .expect(201);
    return (reg.body as { id: number }[])[0]!.id;
  }

  const audits = async () =>
    (await t.get('/audit-logs?action=trigger.pause', cookie).expect(200)).body as AuditLogPage;

  beforeEach(async () => {
    fake = new FakeTarget();
    const detection: QuartzDetection = {
      schema: 'QUARTZ',
      dbNow: DB_NOW,
      tableSets: [
        {
          prefix: 'QRTZ_',
          tableNames: Object.fromEntries(TABLES.map((n) => [n, `QRTZ_${n}`])),
          features: {
            simpropTriggers: false,
            triggerPriority: true,
            firedPriority: true,
            firedSchedTime: true,
            jobNonconcurrent: true,
            jobUpdateData: true,
            cronTimeZone: true,
          },
          boolFormat: '10',
          boolFormatSource: 'values',
          writeCapable: true,
          missingPrivileges: [],
          warnings: [],
          schedulers: [
            {
              schedName: 'S',
              jobCount: 1,
              triggerCount: 1,
              nodeCount: 2,
              activeNodeCount: 2,
              expectedNodeCount: 2,
            },
          ],
        },
      ],
      unusable: [],
    };
    const detector: QuartzDetector = () => Promise.resolve(structuredClone(detection));
    t = await createTestApp({
      overrides: [
        { provide: QUARTZ_DETECTOR, useValue: detector },
        { provide: TargetPoolManager, useValue: new TargetPoolManager([fake.adapter]) },
      ],
    });
    cookie = await t.login(ADMIN.username, ADMIN.password);
  });

  afterEach(async () => {
    await t.close();
  });

  it('미리보기는 대상, 영향 범위, 실행에 붙일 기대 상태를 돌려주고 대상 DB를 바꾸지 않는다', async () => {
    const id = await register('c');
    const res = await t
      .send('post', `/schedulers/${id}/commands/preview`, { command: PAUSE }, cookie)
      .expect(200);
    expect(res.body).toEqual({
      dbNow: DB_NOW,
      command: PAUSE,
      scheduler: {
        id,
        displayName: 'S',
        schedName: 'S',
        connectionName: 'c',
        envLabel: 'prod',
      },
      targets: [{ group: 'g', name: 't', jobGroup: 'jg', jobName: 'j', state: 'WAITING' }],
      expected: [{ group: 'g', name: 't', state: 'WAITING' }],
      changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
      warnings: [],
      blocked: null,
    } satisfies CommandPreviewResponse);
    expect(fake.writes).toBe(0);
    expect((await audits()).items).toEqual([]);
  });

  it('실행하면 바꾸고 변경 전후를 감사 로그에 남긴다', async () => {
    const id = await register('c');
    const preview = (
      await t.send('post', `/schedulers/${id}/commands/preview`, { command: PAUSE }, cookie)
    ).body as CommandPreviewResponse;
    const res = await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command: PAUSE, expected: preview.expected },
        cookie,
      )
      .expect(200);
    const result = res.body as CommandResultDto;
    expect(result).toMatchObject({
      dbNow: DB_NOW,
      changed: true,
      changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
      before: [{ group: 'g', name: 't', state: 'WAITING' }],
      after: [{ group: 'g', name: 't', state: 'PAUSED' }],
    });
    expect(fake.committed).toBe('PAUSED');

    const [log] = (await audits()).items;
    expect(log).toMatchObject({
      id: result.auditId,
      action: 'trigger.pause',
      targetType: 'trigger',
      schedulerId: id,
      result: 'success',
      username: ADMIN.username,
      target: { schedName: 'S', trigger: { group: 'g', name: 't' } },
      before: { command: PAUSE, expected: preview.expected },
      after: {
        triggers: [{ group: 'g', name: 't', state: 'PAUSED' }],
        changes: result.changes,
      },
    });
  });

  it('화면에서 본 상태와 다르면 409 STATE_CONFLICT와 최신 상태를 주고 바꾸지 않는다 (X-04)', async () => {
    const id = await register('c');
    fake.committed = 'PAUSED';
    const res = await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command: PAUSE, expected: [{ group: 'g', name: 't', state: 'WAITING' }] },
        cookie,
      )
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'STATE_CONFLICT',
      current: [{ group: 'g', name: 't', state: 'PAUSED' }],
    });
    expect(fake.writes).toBe(0);
    const [log] = (await audits()).items;
    expect(log).toMatchObject({
      result: 'failure',
      errorCode: 'STATE_CONFLICT',
      after: { triggers: [{ group: 'g', name: 't', state: 'PAUSED' }] },
    });
  });

  it('잠금 대기 초과는 409 LOCK_TIMEOUT으로 응답하고 실패를 기록한다 (X-01)', async () => {
    const id = await register('c');
    fake.lockError = new TargetError('LOCK_TIMEOUT', { driverCode: 'ORA-30006' });
    const res = await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command: PAUSE, expected: [{ group: 'g', name: 't', state: 'WAITING' }] },
        cookie,
      )
      .expect(409);
    expect(res.body).toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(fake.committed).toBe('WAITING');
    expect((await audits()).items[0]).toMatchObject({
      result: 'failure',
      errorCode: 'LOCK_TIMEOUT',
    });
  });

  it('읽기 전용 접속은 미리보기에 차단 사유를 주고 실행은 대상 DB에 닿지 않고 거부한다 (FR-CTL-00a)', async () => {
    const id = await register('ro', true);
    const preview = (
      await t
        .send('post', `/schedulers/${id}/commands/preview`, { command: PAUSE }, cookie)
        .expect(200)
    ).body as CommandPreviewResponse;
    expect(preview.blocked).toMatchObject({ code: 'READ_ONLY' });

    const res = await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command: PAUSE, expected: preview.expected },
        cookie,
      )
      .expect(409);
    expect(res.body).toMatchObject({ code: 'READ_ONLY' });
    expect(fake.writes).toBe(0);
    expect(fake.maxInLock).toBe(0);
    expect((await audits()).items[0]).toMatchObject({ result: 'failure', errorCode: 'READ_ONLY' });
  });

  it('없는 트리거는 404, 기대 상태가 없으면 400이다', async () => {
    const id = await register('c');
    fake.committed = null;
    await t
      .send('post', `/schedulers/${id}/commands/preview`, { command: PAUSE }, cookie)
      .expect(404);
    const bad = await t
      .send('post', `/schedulers/${id}/commands`, { command: PAUSE }, cookie)
      .expect(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    await t
      .send(
        'post',
        `/schedulers/${id}/commands/preview`,
        { command: { type: 'dropTable', trigger: { group: 'g', name: 't' } } },
        cookie,
      )
      .expect(400);
  });

  it('같은 스케줄러의 명령은 하나씩 실행한다', async () => {
    const id = await register('c');
    fake.lockDelayMs = 30;
    const send = (state: string) =>
      t.send(
        'post',
        `/schedulers/${id}/commands`,
        { command: PAUSE, expected: [{ group: 'g', name: 't', state }] },
        cookie,
      );
    const [first, second] = await Promise.all([send('WAITING'), send('WAITING')]);
    // 하나가 먼저 PAUSED로 바꾸므로, 다른 하나는 바뀐 상태를 보고 STATE_CONFLICT로 끝난다
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fake.maxInLock).toBe(1);
  });
});
