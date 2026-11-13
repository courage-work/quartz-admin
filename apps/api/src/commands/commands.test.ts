import {
  BATCH_ITEMS_MAX,
  type AuditLogPage,
  type BatchPreviewResponse,
  type BatchResultResponse,
  type CommandPreviewResponse,
  type CommandResultDto,
  type CronPreviewResponse,
  type QuartzCommand,
  type TimeZonesResponse,
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
import { CLOCK } from '../common/clock.js';
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
 * 트리거 하나(그룹 `g`)를 가진 가짜 Oracle 대상. `nft`는 NEXT_FIRE_TIME, `pausedGroups`는 PAUSED_TRIGGER_GRPS 행이다. UPDATE가 상태를 바꾸고, 커밋하지 않고 되돌리면 원래대로 돌아간다.
 * 잠금 행을 잡은 트랜잭션 수를 세어 직렬화를 확인한다.
 */
class FakeTarget {
  committed: string | null = 'WAITING';
  nft = DB_NOW + 60_000;
  pausedGroups: string[] = [];
  /** JOB_DETAILS에 잡(`jg/j`)이 있는지 */
  jobExists = true;
  /** 즉시 실행으로 넣은 TRIGGERS 행의 바인드 값 */
  inserted: BindValue[][] = [];
  /** 스케줄 수정으로 바꾼 SIMPLE_TRIGGERS 행의 바인드 값 */
  rescheduled: BindValue[][] = [];
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
    let dirty: { state: string | null; pausedGroups: string[] } | null = null;
    const current = () => (dirty ? dirty.state : this.committed);
    const groups = () => (dirty ? dirty.pausedGroups : this.pausedGroups);
    const touch = () => (dirty ??= { state: this.committed, pausedGroups: [...this.pausedGroups] });
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
        if (sql.includes('QRTZ_PAUSED_TRIGGER_GRPS')) {
          return groups().map((g) => ({ G: g })) as Row[] as R[];
        }
        if (sql.includes('QRTZ_FIRED_TRIGGERS')) return [];
        // 잡 상세(getJobDetail). 트리거 수 하위 질의에 QRTZ_TRIGGERS가 있어 먼저 본다
        if (sql.includes('JOB_CLASS_NAME')) {
          const rows: Row[] = this.jobExists
            ? [
                {
                  G: 'jg',
                  N: 'j',
                  C: 'x.Job',
                  D: null,
                  DU: '1',
                  NC: '0',
                  UD: '0',
                  RR: '0',
                  TC: current() === null ? 0 : 1,
                  DATA: null,
                },
              ]
            : [];
          return rows as R[];
        }
        if (sql.includes('QRTZ_JOB_DETAILS')) {
          return [{ C: this.jobExists ? 1 : 0 }] as Row[] as R[];
        }
        if (sql.includes('QRTZ_SCHEDULER_STATE')) {
          return [{ N: 'node-1', L: DB_NOW - 1_000, I: 7_500 }] as Row[] as R[];
        }
        if (sql.includes('COUNT(*)') && sql.includes('QRTZ_TRIGGERS')) {
          return [{ C: 0 }] as Row[] as R[];
        }
        if (sql.includes('LEFT JOIN') && sql.includes('QRTZ_TRIGGERS')) {
          const state = current();
          const rows: Row[] =
            state === null
              ? []
              : [
                  {
                    G: 'g',
                    N: 't',
                    JG: 'jg',
                    JN: 'j',
                    D: null,
                    TY: 'SIMPLE',
                    ST: state,
                    NFT: this.nft,
                    PFT: -1,
                    STT: DB_NOW - 86_400_000,
                    ET: 0,
                    PR: 5,
                    MI: 0,
                    CAL: null,
                    CE: null,
                    TZ: null,
                    RC: -1,
                    RI: 60_000,
                    TT: 3,
                  },
                ];
          return rows as R[];
        }
        if (sql.includes('QRTZ_TRIGGERS')) {
          const state = current();
          const rows: Row[] =
            state === null ? [] : [{ G: 'g', N: 't', JG: 'jg', JN: 'j', ST: state, NFT: this.nft }];
          return rows as R[];
        }
        throw new Error(`예상하지 못한 SQL: ${sql}`);
      },
      execute: (sql: string, binds: readonly BindValue[] = []) => {
        this.writes++;
        if (/^DELETE FROM "QUARTZ"\."QRTZ_(SIMPLE|CRON|SIMPROP|BLOB)_TRIGGERS"/.test(sql)) {
          return Promise.resolve(sql.includes('SIMPLE') && current() !== null ? 1 : 0);
        }
        if (sql.startsWith('DELETE FROM "QUARTZ"."QRTZ_TRIGGERS"')) {
          if (current() === null) return Promise.resolve(0);
          touch().state = null;
          return Promise.resolve(1);
        }
        if (sql.startsWith('DELETE FROM "QUARTZ"."QRTZ_JOB_DETAILS"')) return Promise.resolve(1);
        if (sql.startsWith('INSERT INTO "QUARTZ"."QRTZ_TRIGGERS"')) {
          this.inserted.push([...binds]);
          return Promise.resolve(1);
        }
        if (sql.startsWith('INSERT INTO "QUARTZ"."QRTZ_SIMPLE_TRIGGERS"'))
          return Promise.resolve(1);
        if (sql.startsWith('UPDATE "QUARTZ"."QRTZ_SIMPLE_TRIGGERS"')) {
          this.rescheduled.push([...binds]);
          return Promise.resolve(1);
        }
        if (sql.startsWith('UPDATE "QUARTZ"."QRTZ_TRIGGERS" SET NEXT_FIRE_TIME')) {
          return Promise.resolve(current() === binds.at(-1) ? 1 : 0);
        }
        if (sql.startsWith('INSERT INTO "QUARTZ"."QRTZ_PAUSED_TRIGGER_GRPS"')) {
          touch().pausedGroups.push(binds[1] as string);
          return Promise.resolve(1);
        }
        if (sql.startsWith('DELETE FROM "QUARTZ"."QRTZ_PAUSED_TRIGGER_GRPS"')) {
          const d = touch();
          const before = d.pausedGroups.length;
          d.pausedGroups = d.pausedGroups.filter((g) => g !== binds[1]);
          return Promise.resolve(before - d.pausedGroups.length);
        }
        const [to, , , from] = binds;
        if (current() !== from) return Promise.resolve(0);
        touch().state = to as string;
        return Promise.resolve(1);
      },
      commit: () => {
        if (dirty) {
          this.committed = dirty.state;
          this.pausedGroups = dirty.pausedGroups;
        }
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
const RESUME: QuartzCommand = { type: 'resumeTrigger', trigger: { group: 'g', name: 't' } };
const expected = (state: string, pausedGroups: string[] = []) => ({
  triggers: [{ group: 'g', name: 't', state }],
  pausedGroups,
});

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
      targets: [
        {
          group: 'g',
          name: 't',
          jobGroup: 'jg',
          jobName: 'j',
          state: 'WAITING',
          nextFireTime: DB_NOW + 60_000,
        },
      ],
      expected: { triggers: [{ group: 'g', name: 't', state: 'WAITING' }], pausedGroups: [] },
      changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
      groupChanges: [],
      inserts: [],
      scheduleChanges: [],
      deletions: { triggers: [], jobs: [] },
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
      before: { triggers: [{ group: 'g', name: 't', state: 'WAITING' }], pausedGroups: [] },
      after: { triggers: [{ group: 'g', name: 't', state: 'PAUSED' }], pausedGroups: [] },
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
        pausedGroups: [],
        changes: result.changes,
        groupChanges: [],
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
        { command: PAUSE, expected: expected('WAITING') },
        cookie,
      )
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'STATE_CONFLICT',
      current: expected('PAUSED'),
    });
    expect(fake.writes).toBe(0);
    const [log] = (await audits()).items;
    expect(log).toMatchObject({
      result: 'failure',
      errorCode: 'STATE_CONFLICT',
      after: expected('PAUSED'),
    });
  });

  it('잠금 대기 초과는 409 LOCK_TIMEOUT으로 응답하고 실패를 기록한다 (X-01)', async () => {
    const id = await register('c');
    fake.lockError = new TargetError('LOCK_TIMEOUT', { driverCode: 'ORA-30006' });
    const res = await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command: PAUSE, expected: expected('WAITING') },
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
        { command: PAUSE, expected: expected(state) },
        cookie,
      );
    const [first, second] = await Promise.all([send('WAITING'), send('WAITING')]);
    // 하나가 먼저 PAUSED로 바꾸므로, 다른 하나는 바뀐 상태를 보고 STATE_CONFLICT로 끝난다
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fake.maxInLock).toBe(1);
  });

  it('그룹 일시정지 안의 지난 트리거 재개는 미리보기에서 막고 실행은 409로 거부한다 (TRD §7.4)', async () => {
    const id = await register('c');
    fake.committed = 'PAUSED';
    fake.nft = DB_NOW - 60_000;
    fake.pausedGroups = ['g'];
    const preview = (
      await t
        .send('post', `/schedulers/${id}/commands/preview`, { command: RESUME }, cookie)
        .expect(200)
    ).body as CommandPreviewResponse;
    expect(preview.blocked).toMatchObject({
      code: 'RESUME_IN_PAUSED_GROUP',
      triggers: [{ group: 'g', name: 't' }],
    });
    expect(preview.expected).toEqual(expected('PAUSED', ['g']));

    const res = await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command: RESUME, expected: preview.expected },
        cookie,
      )
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'RESUME_IN_PAUSED_GROUP',
      current: [{ group: 'g', name: 't' }],
    });
    expect(fake.committed).toBe('PAUSED');
    const logs = (await t.get('/audit-logs?action=trigger.resume', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items[0]).toMatchObject({
      result: 'failure',
      errorCode: 'RESUME_IN_PAUSED_GROUP',
      targetType: 'trigger',
    });
  });

  it('트리거 그룹 일시정지는 그룹 행을 넣고 그룹 대상으로 감사 로그를 남긴다', async () => {
    const id = await register('c');
    const command: QuartzCommand = { type: 'pauseTriggerGroup', group: 'g' };
    const preview = (
      await t.send('post', `/schedulers/${id}/commands/preview`, { command }, cookie).expect(200)
    ).body as CommandPreviewResponse;
    expect(preview.groupChanges).toEqual([{ group: 'g', paused: true }]);

    const result = (
      await t
        .send('post', `/schedulers/${id}/commands`, { command, expected: preview.expected }, cookie)
        .expect(200)
    ).body as CommandResultDto;
    expect(result).toMatchObject({
      changed: true,
      groupChanges: [{ group: 'g', paused: true }],
      after: expected('PAUSED', ['g']),
    });
    expect(fake.pausedGroups).toEqual(['g']);
    const logs = (await t.get('/audit-logs?action=trigger_group.pause', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items[0]).toMatchObject({
      result: 'success',
      targetType: 'trigger_group',
      target: { schedName: 'S', group: 'g' },
    });
  });

  it('즉시 실행은 사용자 이름을 남긴 일회성 트리거를 넣고 잡 대상으로 감사 로그를 남긴다 (TRD §7.5)', async () => {
    const id = await register('c');
    const command: QuartzCommand = { type: 'triggerJob', job: { group: 'jg', name: 'j' } };
    const preview = (
      await t.send('post', `/schedulers/${id}/commands/preview`, { command }, cookie).expect(200)
    ).body as CommandPreviewResponse;
    expect(preview.expected).toEqual({ triggers: [], pausedGroups: [] });
    expect(preview.inserts).toEqual([
      {
        group: 'DEFAULT',
        name: null,
        jobGroup: 'jg',
        jobName: 'j',
        state: 'WAITING',
        startTime: DB_NOW,
        description: `quartz-admin: ${ADMIN.username}`,
      },
    ]);

    const result = (
      await t
        .send('post', `/schedulers/${id}/commands`, { command, expected: preview.expected }, cookie)
        .expect(200)
    ).body as CommandResultDto;
    expect(result.changed).toBe(true);
    expect(result.inserts[0]?.name).toMatch(/^MT_/);
    expect(fake.inserted).toHaveLength(1);
    const logs = (await t.get('/audit-logs?action=job.trigger', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items[0]).toMatchObject({
      result: 'success',
      targetType: 'job',
      target: { schedName: 'S', job: { group: 'jg', name: 'j' } },
      after: { inserts: result.inserts },
    });
  });

  it('즉시 실행할 잡이 없으면 404이고 실패를 기록한다', async () => {
    const id = await register('c');
    fake.jobExists = false;
    const command: QuartzCommand = { type: 'triggerJob', job: { group: 'jg', name: 'missing' } };
    await t.send('post', `/schedulers/${id}/commands/preview`, { command }, cookie).expect(404);
    await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command, expected: { triggers: [], pausedGroups: [] } },
        cookie,
      )
      .expect(404);
    expect(fake.inserted).toEqual([]);
    const logs = (await t.get('/audit-logs?action=job.trigger', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items[0]).toMatchObject({ result: 'failure', errorCode: 'NOT_FOUND' });
  });

  it('SIMPLE 스케줄 수정은 바꾸고 trigger.reschedule로 기록한다. 잘못된 값은 400 INVALID_SCHEDULE (TRD §7.6)', async () => {
    const id = await register('c');
    const command: QuartzCommand = {
      type: 'updateSimpleSchedule',
      trigger: { group: 'g', name: 't' },
      repeatIntervalMs: 5_000,
      repeatCount: 3,
    };
    const preview = (
      await t.send('post', `/schedulers/${id}/commands/preview`, { command }, cookie).expect(200)
    ).body as CommandPreviewResponse;
    expect(preview.scheduleChanges).toEqual([
      {
        group: 'g',
        name: 't',
        from: {
          kind: 'SIMPLE',
          repeatIntervalMs: 60_000,
          repeatCount: -1,
          timesTriggered: 3,
          startTime: DB_NOW - 86_400_000,
          nextFireTime: DB_NOW + 60_000,
        },
        to: {
          kind: 'SIMPLE',
          repeatIntervalMs: 5_000,
          repeatCount: 3,
          timesTriggered: 0,
          startTime: DB_NOW,
          nextFireTime: DB_NOW,
        },
        upcoming: [DB_NOW, DB_NOW + 5_000, DB_NOW + 10_000, DB_NOW + 15_000],
      },
    ]);
    const result = (
      await t
        .send('post', `/schedulers/${id}/commands`, { command, expected: preview.expected }, cookie)
        .expect(200)
    ).body as CommandResultDto;
    expect(result.changed).toBe(true);
    expect(fake.rescheduled[0]?.slice(0, 3)).toEqual([3, 5_000, 0]);
    const logs = (await t.get('/audit-logs?action=trigger.reschedule', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items[0]).toMatchObject({
      result: 'success',
      targetType: 'trigger',
      after: { scheduleChanges: result.scheduleChanges },
    });

    const bad: QuartzCommand = { ...command, repeatIntervalMs: 0 };
    const badPreview = (
      await t
        .send('post', `/schedulers/${id}/commands/preview`, { command: bad }, cookie)
        .expect(200)
    ).body as CommandPreviewResponse;
    expect(badPreview.blocked).toMatchObject({ code: 'INVALID_SCHEDULE' });
    const res = await t
      .send(
        'post',
        `/schedulers/${id}/commands`,
        { command: bad, expected: badPreview.expected },
        cookie,
      )
      .expect(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SCHEDULE' });
  });

  it('트리거 상세를 돌려주고 없으면 404', async () => {
    const id = await register('c');
    const res = await t.get(`/schedulers/${id}/triggers/detail?group=g&name=t`, cookie).expect(200);
    expect(res.body).toMatchObject({
      dbNow: DB_NOW,
      trigger: { group: 'g', name: 't', type: 'SIMPLE', simple: { repeatIntervalMs: 60_000 } },
    });
    fake.committed = null;
    await t.get(`/schedulers/${id}/triggers/detail?group=g&name=t`, cookie).expect(404);
  });

  it('트리거 삭제는 지우고 삭제 전 정의를 trigger.delete 기록의 before에 남긴다 (FR-CTL-09)', async () => {
    const id = await register('c');
    const command: QuartzCommand = { type: 'deleteTrigger', trigger: { group: 'g', name: 't' } };
    const preview = (
      await t.send('post', `/schedulers/${id}/commands/preview`, { command }, cookie).expect(200)
    ).body as CommandPreviewResponse;
    expect(preview.deletions).toEqual({ triggers: [{ group: 'g', name: 't' }], jobs: [] });

    const result = (
      await t
        .send('post', `/schedulers/${id}/commands`, { command, expected: preview.expected }, cookie)
        .expect(200)
    ).body as CommandResultDto;
    expect(result).toMatchObject({ changed: true, after: { triggers: [], pausedGroups: [] } });
    expect(fake.committed).toBeNull();
    const logs = (await t.get('/audit-logs?action=trigger.delete', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items[0]).toMatchObject({
      result: 'success',
      targetType: 'trigger',
      before: {
        command,
        expected: preview.expected,
        snapshot: { trigger: { group: 'g', name: 't', type: 'SIMPLE' } },
      },
      after: { deletions: result.deletions },
    });
  });

  describe('일괄 제어 (FR-CTL-10)', () => {
    const pauseAudits = async () =>
      (await t.get('/audit-logs?action=trigger.pause', cookie).expect(200)).body as AuditLogPage;
    const batchPreview = (id: number, commands: QuartzCommand[]) =>
      t.send('post', `/schedulers/${id}/commands/batch/preview`, { commands }, cookie);
    const batch = (id: number, items: unknown[]) =>
      t.send('post', `/schedulers/${id}/commands/batch`, { items }, cookie);

    it('미리보기는 항목마다 영향 범위와 기대 상태를 주고 대상 DB를 바꾸지 않는다', async () => {
      const id = await register('c');
      const body = (await batchPreview(id, [PAUSE, RESUME]).expect(200))
        .body as BatchPreviewResponse;
      expect(body).toMatchObject({
        dbNow: DB_NOW,
        scheduler: { id, schedName: 'S', envLabel: 'prod' },
        blocked: null,
      });
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toMatchObject({
        command: PAUSE,
        error: null,
        preview: {
          expected: expected('WAITING'),
          changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
          blocked: null,
        },
      });
      // 일시정지되지 않은 트리거의 재개는 바뀌는 것이 없다
      expect(body.items[1]!.preview!.changes).toEqual([]);
      expect(body.items[1]!.preview!.warnings.map((w) => w.code)).toContain('NO_CHANGE');
      expect(fake.writes).toBe(0);
      expect((await pauseAudits()).items).toEqual([]);
    });

    it('대상이 없는 항목은 그 항목의 오류로 알린다', async () => {
      const id = await register('c');
      fake.committed = null;
      const body = (await batchPreview(id, [PAUSE]).expect(200)).body as BatchPreviewResponse;
      expect(body.items[0]).toMatchObject({ preview: null, error: { code: 'NOT_FOUND' } });
    });

    it('일부가 실패해도 나머지를 실행하고 항목마다 결과와 감사 기록을 남긴다', async () => {
      const id = await register('c');
      const body = (
        await batch(id, [
          // 화면에서 본 상태와 달라 실패한다
          { command: PAUSE, expected: expected('PAUSED') },
          { command: PAUSE, expected: expected('WAITING') },
        ]).expect(200)
      ).body as BatchResultResponse;
      expect(body.items).toMatchObject([
        { command: PAUSE, status: 'failure', error: { code: 'STATE_CONFLICT' } },
        {
          command: PAUSE,
          status: 'success',
          changed: true,
          changes: [{ group: 'g', name: 't', from: 'WAITING', to: 'PAUSED' }],
        },
      ]);
      expect(fake.committed).toBe('PAUSED');

      const logs = (await pauseAudits()).items;
      expect(logs).toHaveLength(2);
      const byIndex = (i: number) =>
        logs.find((l) => (l.before as { batch: { index: number } }).batch.index === i);
      expect(byIndex(1)).toMatchObject({
        action: 'trigger.pause',
        result: 'failure',
        errorCode: 'STATE_CONFLICT',
        before: { command: PAUSE, batch: { id: body.batchId, total: 2 } },
      });
      expect(byIndex(2)).toMatchObject({
        id: (body.items[1] as { auditId: number }).auditId,
        result: 'success',
        before: { command: PAUSE, expected: expected('WAITING'), batch: { id: body.batchId } },
      });
    });

    it('항목의 대상 DB 오류는 다음 항목을 실행하고, 연결할 수 없으면 남은 항목을 건너뛴다', async () => {
      const id = await register('c');
      const items = [
        { command: PAUSE, expected: expected('WAITING') },
        { command: PAUSE, expected: expected('WAITING') },
      ];
      fake.lockError = new TargetError('TARGET_ERROR');
      let body = (await batch(id, items).expect(200)).body as BatchResultResponse;
      expect(body.items.map((it) => it.status)).toEqual(['failure', 'failure']);

      fake.lockError = new TargetError('TARGET_UNREACHABLE');
      body = (await batch(id, items).expect(200)).body as BatchResultResponse;
      expect(body.items).toMatchObject([
        { status: 'failure', error: { code: 'TARGET_UNREACHABLE' } },
        { status: 'skipped', error: { code: 'BATCH_STOPPED' } },
      ]);
      // 건너뛴 항목은 실행하지 않았으므로 감사 기록이 없다
      expect((await pauseAudits()).items).toHaveLength(3);
      expect(fake.committed).toBe('WAITING');
    });

    it('읽기 전용 접속은 미리보기에 차단 사유를 주고 실행은 항목마다 거부해 기록한다', async () => {
      const id = await register('ro', true);
      const preview = (await batchPreview(id, [PAUSE]).expect(200)).body as BatchPreviewResponse;
      expect(preview.blocked?.code).toBe('READ_ONLY');
      const body = (
        await batch(id, [{ command: PAUSE, expected: expected('WAITING') }]).expect(200)
      ).body as BatchResultResponse;
      expect(body.items).toMatchObject([{ status: 'failure', error: { code: 'READ_ONLY' } }]);
      expect(fake.writes).toBe(0);
      expect((await pauseAudits()).items).toMatchObject([
        { result: 'failure', errorCode: 'READ_ONLY' },
      ]);
    });

    it('항목 수 상한, 일괄로 할 수 없는 명령, 빈 목록은 400, 없는 스케줄러는 404이고 기록하지 않는다', async () => {
      const id = await register('c');
      const item = { command: PAUSE, expected: expected('WAITING') };
      const deleting = {
        command: { type: 'deleteTrigger', trigger: { group: 'g', name: 't' } },
        expected: expected('WAITING'),
      };
      for (const items of [
        Array.from({ length: BATCH_ITEMS_MAX + 1 }, () => item),
        [deleting],
        [],
      ]) {
        await batch(id, items).expect(400);
      }
      await batchPreview(id, []).expect(400);
      await batch(999, [item]).expect(404);
      expect((await pauseAudits()).items).toEqual([]);
      expect(fake.writes).toBe(0);
    });
  });
});

describe('cron 미리보기 API (TRD §7.6)', () => {
  let t: TestApp;
  let cookie: string;
  const NOW = Date.UTC(2026, 10, 10, 3, 0, 0);

  beforeEach(async () => {
    t = await createTestApp({ overrides: [{ provide: CLOCK, useValue: () => NOW }] });
    cookie = await t.login(ADMIN.username, ADMIN.password);
  });

  afterEach(async () => {
    await t.close();
  });

  it('다음 실행 시각을 계산한다. 식은 대문자로 돌려준다', async () => {
    const res = await t
      .send(
        'post',
        '/cron/preview',
        { expression: '0 0 12 ? * mon-fri', timeZone: 'Asia/Seoul' },
        cookie,
      )
      .expect(200);
    const body = res.body as CronPreviewResponse;
    expect(body).toMatchObject({ valid: true, expression: '0 0 12 ? * MON-FRI', after: NOW });
    // 2026-11-10(화) 12:00 KST = 03:00Z는 지금이라 다음은 11일 03:00Z부터 평일 5개
    expect(body.valid && body.nextFireTimes).toEqual(
      [11, 12, 13, 16, 17].map((d) => Date.UTC(2026, 10, d, 3)),
    );
  });

  it('문법 오류와 알 수 없는 타임존을 알려 준다', async () => {
    const syntax = (
      await t.send('post', '/cron/preview', { expression: '0 0 25 * * ?', timeZone: 'UTC' }, cookie)
    ).body as CronPreviewResponse;
    expect(syntax).toMatchObject({ valid: false, error: { code: 'RANGE', field: '시' } });

    const zone = (
      await t.send(
        'post',
        '/cron/preview',
        { expression: '0 0 12 * * ?', timeZone: 'Mars/Olympus' },
        cookie,
      )
    ).body as CronPreviewResponse;
    expect(zone).toMatchObject({ valid: false, error: { code: 'TIME_ZONE' } });
  });

  it('고를 수 있는 타임존 목록', async () => {
    const res = await t.get('/cron/time-zones', cookie).expect(200);
    const { zones } = res.body as TimeZonesResponse;
    expect(zones).toContain('Asia/Seoul');
    expect(zones).toContain('UTC');
  });
});
