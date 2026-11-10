import type { CommandExpected, QuartzCommand } from '@qa/shared';
import type oracledb from 'oracledb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_GROUPS_PAUSED,
  CommandRejection,
  OracleAdapter,
  QUARTZ_REQUIRED_TABLES,
  TargetPoolManager,
  createTableSet,
  executeCommand,
  expectedOf,
  oracleDialect,
  previewCommand,
  queryDbNowMillis,
  type CommandOutcome,
  type PoolTarget,
  type SchedulerCommandContext,
  type TargetConn,
} from '../../src/index.js';
import {
  QUARTZ_VERSION,
  listExecutions,
  quartzTableName,
  sleep,
  startOracleQuartzCluster,
  waitFor,
  type OracleQuartzCluster,
  type RowSnapshot,
  type TestbedClient,
  type TestbedNode,
  type TriggerSpec,
} from '../support/index.js';

/** 차등 테스트의 두 기준 인스턴스. 같은 초기 상태를 만들고 한쪽은 Quartz API, 다른 쪽은 도구로 명령한다 */
const REF_QUARTZ = 'ReschedQuartz';
const REF_TOOL = 'ReschedTool';
const T = (name: string) => quartzTableName(name as Parameters<typeof quartzTableName>[0]);
const DAY = 86_400_000;

const features = {
  simpropTriggers: true,
  triggerPriority: true,
  firedPriority: true,
  firedSchedTime: true,
  jobNonconcurrent: true,
  jobUpdateData: true,
  cronTimeZone: true,
};

/**
 * 행 스냅샷에서 뺄 컬럼을 지우고 다시 정렬한다. 스케줄 수정의 차등 비교는 PREV_FIRE_TIME과 START_TIME(CRON),
 * 시각을 지금으로 잡는 SIMPLE 케이스는 NEXT_FIRE_TIME까지 뺀다 (부록 A.6)
 */
function normalize(snapshot: RowSnapshot, drop: string[]): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(snapshot).map(([table, rows]) => [
      table,
      (rows as Record<string, unknown>[])
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(Object.entries(row).filter(([col]) => !drop.includes(col))),
          ),
        )
        .sort(),
    ]),
  );
}

/**
 * 스케줄 수정 (B-20, TRD §7.6, 부록 A.6 C-01~C-13, S-01~S-07).
 * 2노드 클러스터와 `start()`하지 않는 기준 인스턴스 두 개를 같은 Oracle 스키마에 띄운다.
 */
describe(`스케줄 수정 (Oracle Free 23, Quartz ${QUARTZ_VERSION})`, () => {
  let cluster: OracleQuartzCluster;
  let refQuartz: TestbedNode;
  let refTool: TestbedNode;
  let conn: oracledb.Connection;
  let pools: TargetPoolManager;
  let target: PoolTarget;

  const ctxFor = (schedName: string): SchedulerCommandContext => ({
    dialect: oracleDialect,
    tables: createTableSet(oracleDialect, {
      schema: cluster.oracle.user,
      tables: {
        ...Object.fromEntries(QUARTZ_REQUIRED_TABLES.map((t) => [t, `QRTZ_${t}`])),
        SIMPROP_TRIGGERS: 'QRTZ_SIMPROP_TRIGGERS',
      },
    }),
    features,
    schedName,
  });

  const run = <R>(fn: (c: TargetConn) => Promise<R>) => pools.withConnection(target, fn);
  const dbNow = () => run((c) => queryDbNowMillis(c, oracleDialect));

  const toolRun = (
    schedName: string,
    command: QuartzCommand,
    expected?: CommandExpected,
  ): Promise<CommandOutcome> =>
    run(async (c) => {
      const ctx = ctxFor(schedName);
      const preview = await previewCommand(c, ctx, command);
      return executeCommand(c, ctx, command, expected ?? expectedOf(preview.subject));
    });

  const toolError = (schedName: string, command: QuartzCommand) =>
    toolRun(schedName, command).then(
      () => null,
      (e: unknown) => e,
    );

  async function lockIsFree(schedName: string): Promise<boolean> {
    try {
      await conn.execute(
        `SELECT LOCK_NAME FROM ${T('LOCKS')} WHERE SCHED_NAME = :1 AND LOCK_NAME = 'TRIGGER_ACCESS' FOR UPDATE WAIT 3`,
        [schedName],
      );
      return true;
    } catch (err) {
      if (/ORA-(30006|00054)/.test(String(err))) return false;
      throw err;
    } finally {
      await conn.rollback();
    }
  }

  async function row(schedName: string, group: string, name: string) {
    const res = await conn.execute<[string, number | null, number | null]>(
      `SELECT TRIGGER_STATE, NEXT_FIRE_TIME, START_TIME FROM ${T('TRIGGERS')} ` +
        `WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = :2 AND TRIGGER_NAME = :3`,
      [schedName, group, name],
    );
    const r = res.rows?.[0];
    return r ? { state: r[0], nft: r[1], start: r[2] } : null;
  }

  beforeAll(async () => {
    cluster = await startOracleQuartzCluster({ nodes: 2 });
    [refQuartz, refTool] = await Promise.all([
      cluster.addReference(REF_QUARTZ),
      cluster.addReference(REF_TOOL),
    ]);
    conn = await cluster.oracle.connect();
    pools = new TargetPoolManager([new OracleAdapter()]);
    target = {
      id: 'reschedule',
      info: {
        kind: 'oracle',
        host: cluster.oracle.container.getHost(),
        port: cluster.oracle.container.getMappedPort(1521),
        username: cluster.oracle.user,
        password: cluster.oracle.password,
        oracleServiceName: 'FREEPDB1',
      },
    };
  });

  afterAll(async () => {
    await pools?.closeAll();
    await conn?.close();
    await cluster?.stop();
  });

  // ── 차등 준비 ───────────────────────────────────────────

  /** 두 기준 인스턴스에 같은 잡(`job-<group>`)과 트리거 `t`를 만든다 */
  async function seedBoth(
    group: string,
    trigger: Omit<TriggerSpec, 'name' | 'group' | 'forJob'>,
    nonConcurrent = false,
  ): Promise<void> {
    for (const ref of [refQuartz, refTool]) {
      await ref.client.addJob({
        name: `job-${group}`,
        group,
        type: nonConcurrent ? 'NonConcurrentSleepJob' : 'RecordingJob',
        durable: true,
      });
      await ref.client.scheduleJob({
        trigger: {
          ...trigger,
          name: 't',
          group,
          forJob: { name: `job-${group}`, group },
        } as TriggerSpec,
      });
    }
  }

  async function fixtureBoth(statements: string[]): Promise<void> {
    for (const sched of [REF_QUARTZ, REF_TOOL]) {
      await refQuartz.client.fixtureSql(
        statements.map((s) => s.replaceAll(':sched', `'${sched}'`)),
      );
    }
  }

  const setState = (group: string, value: string) =>
    `UPDATE ${T('TRIGGERS')} SET TRIGGER_STATE = '${value}' WHERE SCHED_NAME = :sched AND TRIGGER_GROUP = '${group}'`;
  const pausedGroupRow = (group: string) =>
    `INSERT INTO ${T('PAUSED_TRIGGER_GRPS')} (SCHED_NAME, TRIGGER_GROUP) VALUES (:sched, '${group}')`;
  const clearPausedGroups = `DELETE FROM ${T('PAUSED_TRIGGER_GRPS')} WHERE SCHED_NAME = :sched`;
  const executingRow = (group: string) =>
    `INSERT INTO ${T('FIRED_TRIGGERS')} (SCHED_NAME, ENTRY_ID, TRIGGER_NAME, TRIGGER_GROUP, INSTANCE_NAME, ` +
    `FIRED_TIME, SCHED_TIME, PRIORITY, STATE, JOB_NAME, JOB_GROUP, IS_NONCONCURRENT, REQUESTS_RECOVERY) ` +
    `VALUES (:sched, '${group}-exe', 'other', '${group}', 'node-x', 1000, 1000, 5, 'EXECUTING', ` +
    `'job-${group}', '${group}', '1', '0')`;

  /** 일 12:00 UTC. 테스트가 정오를 넘기지 않는 한 두 인스턴스의 다음 실행 시각이 같다 */
  const NOON = '0 0 12 * * ?';
  const cronSeed = (more: Partial<TriggerSpec> = {}) =>
    ({
      type: 'cron',
      cron: '0 0 6 * * ?',
      timeZone: 'Asia/Seoul',
      startAt: Date.now() - DAY,
      ...more,
    }) as Omit<TriggerSpec, 'name' | 'group' | 'forJob'>;
  const cronCommand = (group: string): QuartzCommand => ({
    type: 'updateCronSchedule',
    trigger: { group, name: 't' },
    cronExpression: NOON,
    timeZone: 'UTC',
  });
  /** Quartz 대응: 기존 값(DESCRIPTION, PRIORITY, MISFIRE_INSTR, END_TIME)은 그대로, startAt은 max(지금, START) (§7.6) */
  const quartzCron = (group: string, start: number, endAt?: number) => (c: TestbedClient) =>
    c.rescheduleJob(
      { group, name: 't' },
      {
        type: 'cron',
        name: 't',
        group,
        cron: NOON,
        timeZone: 'UTC',
        startAt: Math.max(Date.now(), start),
        ...(endAt ? { endAt } : {}),
      },
    );

  async function differential(
    quartz: (client: TestbedClient) => Promise<unknown>,
    command: QuartzCommand,
    drop: string[],
  ): Promise<CommandOutcome> {
    await quartz(refQuartz.client);
    const out = await toolRun(REF_TOOL, command);
    const [q, t] = await Promise.all([
      refQuartz.client.snapshot(REF_QUARTZ),
      refQuartz.client.snapshot(REF_TOOL),
    ]);
    expect(normalize(t, drop)).toEqual(normalize(q, drop));
    expect(await lockIsFree(REF_TOOL)).toBe(true);
    return out;
  }

  /**
   * 도구로만 확인하는 명령. 차등 테스트가 두 기준 인스턴스의 전체 행을 비교하므로, 행이 계속 같도록
   * 양쪽에 같은 명령을 실행하고 도구 쪽 결과를 돌려준다
   */
  async function toolBoth(command: QuartzCommand): Promise<CommandOutcome> {
    await toolRun(REF_QUARTZ, command);
    return toolRun(REF_TOOL, command);
  }

  /** Quartz도 도구도 거부하고 두 쪽 행이 그대로인지 */
  async function bothReject(
    quartz: (client: TestbedClient) => Promise<unknown>,
    command: QuartzCommand,
    code: string,
  ): Promise<void> {
    const before = await refTool.client.snapshot(REF_TOOL);
    await expect(quartz(refQuartz.client)).rejects.toThrow();
    const err = await toolError(REF_TOOL, command);
    expect(err).toBeInstanceOf(CommandRejection);
    expect(err).toMatchObject({ code });
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(before);
  }

  const CRON_DROP = ['PREV_FIRE_TIME', 'START_TIME'];

  // ── CRON (부록 A.6 C-01~C-12) ────────────────────────────

  it('C-01 식·타임존 변경, 다음 실행 시각 재계산, 상태 WAITING (차등)', async () => {
    const start = Date.now() - DAY;
    await seedBoth('c01', cronSeed({ startAt: start }));
    const out = await differential(quartzCron('c01', start), cronCommand('c01'), CRON_DROP);
    expect(out.scheduleChanges[0]?.to).toMatchObject({ cronExpression: NOON, timeZone: 'UTC' });
    expect((await row(REF_TOOL, 'c01', 't'))?.state).toBe('WAITING');
  });

  it('C-02·C-03 개별 일시정지 유지: P는 P, PB는 실행 중이면 PB 아니면 P (도구)', async () => {
    await seedBoth('c02', cronSeed());
    await fixtureBoth([setState('c02', 'PAUSED')]);
    const out = await toolBoth(cronCommand('c02'));
    expect((await row(REF_TOOL, 'c02', 't'))?.state).toBe('PAUSED');
    expect(out.warnings.map((w) => w.code)).toContain('PAUSE_KEPT');

    await seedBoth('c03r', cronSeed(), true);
    await fixtureBoth([setState('c03r', 'PAUSED_BLOCKED'), executingRow('c03r')]);
    await toolBoth(cronCommand('c03r'));
    expect((await row(REF_TOOL, 'c03r', 't'))?.state).toBe('PAUSED_BLOCKED');

    await seedBoth('c03i', cronSeed(), true);
    await fixtureBoth([setState('c03i', 'PAUSED_BLOCKED')]);
    await toolBoth(cronCommand('c03i'));
    expect((await row(REF_TOOL, 'c03i', 't'))?.state).toBe('PAUSED');
  });

  it('C-04 동시 실행 금지 잡 실행 중의 BLOCKED는 BLOCKED (차등)', async () => {
    const start = Date.now() - DAY;
    await seedBoth('c04', cronSeed({ startAt: start }), true);
    await fixtureBoth([setState('c04', 'BLOCKED'), executingRow('c04')]);
    await differential(quartzCron('c04', start), cronCommand('c04'), CRON_DROP);
    expect((await row(REF_TOOL, 'c04', 't'))?.state).toBe('BLOCKED');
  });

  it('C-06 ERROR는 WAITING으로 풀린다 (차등)', async () => {
    const start = Date.now() - DAY;
    await seedBoth('c06', cronSeed({ startAt: start }));
    await fixtureBoth([setState('c06', 'ERROR')]);
    const out = await differential(quartzCron('c06', start), cronCommand('c06'), CRON_DROP);
    expect((await row(REF_TOOL, 'c06', 't'))?.state).toBe('WAITING');
    expect(out.warnings.map((w) => w.code)).toContain('ERROR_CLEARED');
  });

  it('C-07·C-08 그룹이 일시정지면 PAUSED, 전체 일시정지만 있으면 그룹 행을 넣고 PAUSED (차등)', async () => {
    const start = Date.now() - DAY;
    await seedBoth('c07', cronSeed({ startAt: start }));
    await fixtureBoth([pausedGroupRow('c07')]);
    try {
      await differential(quartzCron('c07', start), cronCommand('c07'), CRON_DROP);
      expect((await row(REF_TOOL, 'c07', 't'))?.state).toBe('PAUSED');
    } finally {
      await fixtureBoth([clearPausedGroups]);
    }

    await seedBoth('c08', cronSeed({ startAt: start }));
    await fixtureBoth([pausedGroupRow(ALL_GROUPS_PAUSED)]);
    try {
      const out = await differential(quartzCron('c08', start), cronCommand('c08'), CRON_DROP);
      expect((await row(REF_TOOL, 'c08', 't'))?.state).toBe('PAUSED');
      expect(out.groupChanges).toEqual([{ group: 'c08', paused: true }]);
    } finally {
      await fixtureBoth([clearPausedGroups]);
    }
  });

  it('C-09·C-10 COMPLETE와 캘린더 연결 트리거는 409, 행은 그대로 (도구)', async () => {
    await seedBoth('c09', cronSeed());
    await fixtureBoth([setState('c09', 'COMPLETE')]);
    const before = await refTool.client.snapshot(REF_TOOL);
    expect(await toolError(REF_TOOL, cronCommand('c09'))).toMatchObject({
      code: 'TRIGGER_COMPLETE',
    });

    await seedBoth('c10', cronSeed());
    await fixtureBoth([
      `UPDATE ${T('TRIGGERS')} SET CALENDAR_NAME = 'holidays' WHERE SCHED_NAME = :sched AND TRIGGER_GROUP = 'c10'`,
    ]);
    const mid = await refTool.client.snapshot(REF_TOOL);
    expect(await toolError(REF_TOOL, cronCommand('c10'))).toMatchObject({
      code: 'CALENDAR_ATTACHED',
    });
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(mid);
    expect(mid.TRIGGERS.length).toBe(before.TRIGGERS.length + 1);
  });

  it('C-11 종료 시각이 지나 더 발화하지 않으면 Quartz도 도구도 거부한다 (차등)', async () => {
    const start = Date.now() - DAY;
    const endAt = Date.now() + 1_500;
    await seedBoth('c11', cronSeed({ startAt: start, endAt, cron: '* * * * * ?' }));
    await sleep(2_000);
    await bothReject(quartzCron('c11', start, endAt), cronCommand('c11'), 'INVALID_SCHEDULE');
  });

  it('C-12 시작 시각이 미래면 다음 실행 시각은 시작 시각 이후 (차등)', async () => {
    const start = Date.now() + 2 * DAY;
    await seedBoth('c12', cronSeed({ startAt: start }));
    // 앞선 CRON 케이스들은 START_TIME이 일부러 다르므로(§7.6) 전체 비교에서는 빼고 이 트리거만 따로 본다.
    // 시작 시각이 미래면 Quartz의 startAt(max(지금, START))도 START라 두 쪽이 같아야 한다
    const out = await differential(quartzCron('c12', start), cronCommand('c12'), CRON_DROP);
    expect(out.scheduleChanges[0]?.to.nextFireTime).toBeGreaterThanOrEqual(start);
    expect(await row(REF_TOOL, 'c12', 't')).toEqual(await row(REF_QUARTZ, 'c12', 't'));
  });

  // ── SIMPLE (부록 A.6 S-01~S-07) ──────────────────────────

  const simpleSeed = (more: Partial<TriggerSpec> = {}) =>
    ({
      type: 'simple',
      intervalMs: 60_000,
      repeatCount: -1,
      startAt: Date.now() - DAY,
      ...more,
    }) as Omit<TriggerSpec, 'name' | 'group' | 'forJob'>;
  const simpleCommand = (
    group: string,
    more: Partial<{ repeatIntervalMs: number; repeatCount: number; startAt: number }> = {},
  ): QuartzCommand => ({
    type: 'updateSimpleSchedule',
    trigger: { group, name: 't' },
    repeatIntervalMs: 5_000,
    repeatCount: 3,
    ...more,
  });
  const quartzSimple =
    (group: string, more: Partial<TriggerSpec> = {}) =>
    (c: TestbedClient) =>
      c.rescheduleJob({ group, name: 't' }, {
        name: 't',
        group,
        intervalMs: 5_000,
        repeatCount: 3,
        ...more,
      } as TriggerSpec);

  it('S-01 간격·횟수 변경, 실행 횟수 0, START = NFT = 지금 (차등, 시각 제외)', async () => {
    await seedBoth('s01', simpleSeed());
    await fixtureBoth([
      `UPDATE ${T('SIMPLE_TRIGGERS')} SET TIMES_TRIGGERED = 7 WHERE SCHED_NAME = :sched AND TRIGGER_GROUP = 's01'`,
    ]);
    const before = await dbNow();
    await differential(quartzSimple('s01'), simpleCommand('s01'), [
      'PREV_FIRE_TIME',
      'START_TIME',
      'NEXT_FIRE_TIME',
    ]);
    const after = await row(REF_TOOL, 's01', 't');
    expect(after?.start).toBe(after?.nft);
    expect(after?.start).toBeGreaterThanOrEqual(before);
  });

  it('S-02 startAt을 주면 START = NFT = startAt (차등)', async () => {
    await seedBoth('s02', simpleSeed());
    const startAt = (await dbNow()) + 3_600_000;
    // 앞선 CRON 케이스들의 START_TIME과 S-01의 지금 기준 시각이 달라 전체 비교에서는 빼고 이 트리거만 따로 본다
    await differential(quartzSimple('s02', { startAt }), simpleCommand('s02', { startAt }), [
      ...CRON_DROP,
      'NEXT_FIRE_TIME',
    ]);
    expect(await row(REF_TOOL, 's02', 't')).toMatchObject({ start: startAt, nft: startAt });
    expect(await row(REF_TOOL, 's02', 't')).toEqual(await row(REF_QUARTZ, 's02', 't'));
  });

  it('S-03 지난 startAt은 400, 행은 그대로 (도구)', async () => {
    await seedBoth('s03', simpleSeed());
    const before = await refTool.client.snapshot(REF_TOOL);
    expect(
      await toolError(REF_TOOL, simpleCommand('s03', { startAt: (await dbNow()) - 60_000 })),
    ).toMatchObject({ code: 'INVALID_SCHEDULE' });
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(before);
  });

  it('S-04·S-05 반복하는데 간격 0, 종료 시각보다 늦은 시작은 Quartz도 도구도 거부한다 (차등)', async () => {
    await seedBoth('s04', simpleSeed());
    await bothReject(
      quartzSimple('s04', { intervalMs: 0 }),
      simpleCommand('s04', { repeatIntervalMs: 0 }),
      'INVALID_SCHEDULE',
    );

    const endAt = Date.now() + 60_000;
    await seedBoth('s05', simpleSeed({ endAt }));
    const startAt = endAt + 60_000;
    await bothReject(
      quartzSimple('s05', { startAt, endAt }),
      simpleCommand('s05', { startAt }),
      'INVALID_SCHEDULE',
    );
  });

  it('S-06 PAUSED는 유지한다 (도구)', async () => {
    await seedBoth('s06', simpleSeed());
    await fixtureBoth([setState('s06', 'PAUSED')]);
    await toolBoth(simpleCommand('s06'));
    expect((await row(REF_TOOL, 's06', 't'))?.state).toBe('PAUSED');
  });

  // ── 실제 클러스터 (부록 A.6 C-05, S-07, C-13) ────────────────

  describe('2노드 클러스터', () => {
    const sched = () => cluster.schedulerName;
    const node = () => cluster.nodes[0]!.client;

    /** 노드가 트리거를 집어(ACQUIRED) 발화까지 `minLeadMs` 이상 남았을 때까지 기다린다 */
    async function waitAcquired(group: string, minLeadMs: number) {
      let acquired: { nft: number } | null = null;
      await waitFor(
        async () => {
          const r = await row(sched(), group, 't');
          const now = await dbNow();
          if (r?.state === 'ACQUIRED' && r.nft !== null && r.nft - now >= minLeadMs) {
            acquired = { nft: r.nft };
            return true;
          }
          return false;
        },
        { timeoutMs: 90_000, intervalMs: 200, message: '노드가 트리거를 집음' },
      );
      return acquired!;
    }

    const runsOf = async (group: string) =>
      listExecutions(conn, { schedName: sched(), triggerGroup: group, triggerName: 't' });

    it('C-05 ACQUIRED를 수정하면 WAITING이 되고 옛 시각에 발화하지 않으며, 새 식의 시각에 발화한다 (통합)', async () => {
      await node().addJob({ name: 'job-c05', group: 'c05', type: 'RecordingJob', durable: true });
      // 매분 0초. 노드는 발화 최대 30초 전에 집는다
      await node().scheduleJob({
        trigger: {
          type: 'cron',
          name: 't',
          group: 'c05',
          cron: '0 * * * * ?',
          timeZone: 'UTC',
          forJob: { name: 'job-c05', group: 'c05' },
        },
      });
      const { nft: oldFire } = await waitAcquired('c05', 5_000);
      const out = await toolRun(sched(), {
        type: 'updateCronSchedule',
        trigger: { group: 'c05', name: 't' },
        cronExpression: '30 * * * * ?',
        timeZone: 'UTC',
      });
      expect(out.changes).toEqual([{ group: 'c05', name: 't', from: 'ACQUIRED', to: 'WAITING' }]);
      const newFire = out.scheduleChanges[0]!.to.nextFireTime!;
      expect(new Date(newFire).getUTCSeconds()).toBe(30);

      // 옛 시각이 지나도 발화하지 않는다
      await waitFor(async () => (await dbNow()) > oldFire + 3_000, { timeoutMs: 40_000 });
      expect((await runsOf('c05')).filter((r) => r.scheduledFireTime === oldFire)).toEqual([]);
      // 새 시각에 발화하고 다음 실행 시각이 옛 식(0초)으로 돌아가지 않는다
      await waitFor(
        async () => (await runsOf('c05')).some((r) => r.scheduledFireTime === newFire),
        {
          timeoutMs: 60_000,
          message: '새 식의 시각에 발화',
        },
      ).catch(async (err: unknown) => {
        // 진단: 실패하면 트리거 행, 실행 기록, FIRED_TRIGGERS를 남긴다
        const fired = await conn.execute(
          `SELECT * FROM ${T('FIRED_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = 'c05'`,
          [sched()],
        );
        console.log('C-05 진단', {
          oldFire,
          newFire,
          dbNow: await dbNow(),
          row: await row(sched(), 'c05', 't'),
          runs: (await runsOf('c05')).map((r) => [r.scheduledFireTime, r.fireTime, r.instanceId]),
          fired: fired.rows,
        });
        throw err;
      });
      const after = await row(sched(), 'c05', 't');
      expect(new Date(after!.nft!).getUTCSeconds()).toBe(30);
    }, 180_000);

    it('S-07 SIMPLE도 ACQUIRED를 수정하면 WAITING이 되고 옛 시각에 발화하지 않는다 (통합)', async () => {
      await node().addJob({ name: 'job-s07', group: 's07', type: 'RecordingJob', durable: true });
      await node().scheduleJob({
        trigger: {
          name: 't',
          group: 's07',
          intervalMs: 40_000,
          startAt: Date.now() + 20_000,
          forJob: { name: 'job-s07', group: 's07' },
        },
      });
      const { nft: oldFire } = await waitAcquired('s07', 4_000);
      const startAt = oldFire + 15_000;
      const out = await toolRun(sched(), {
        type: 'updateSimpleSchedule',
        trigger: { group: 's07', name: 't' },
        repeatIntervalMs: 60_000,
        repeatCount: -1,
        startAt,
      });
      expect(out.changes[0]).toMatchObject({ from: 'ACQUIRED', to: 'WAITING' });
      await waitFor(
        async () => (await runsOf('s07')).some((r) => r.scheduledFireTime === startAt),
        {
          timeoutMs: 60_000,
          message: '새 시작 시각에 발화',
        },
      );
      expect((await runsOf('s07')).filter((r) => r.scheduledFireTime === oldFire)).toEqual([]);
    }, 180_000);

    it('C-13 실제 발화 시각이 미리보기 5개와 같다 (통합)', async () => {
      await node().addJob({ name: 'job-c13', group: 'c13', type: 'RecordingJob', durable: true });
      await node().scheduleJob({
        trigger: {
          type: 'cron',
          name: 't',
          group: 'c13',
          cron: '0 0 0 1 1 ? 2099',
          timeZone: 'UTC',
          forJob: { name: 'job-c13', group: 'c13' },
        },
      });
      const out = await toolRun(sched(), {
        type: 'updateCronSchedule',
        trigger: { group: 'c13', name: 't' },
        cronExpression: '*/10 * * * * ?',
        timeZone: 'UTC',
      });
      const upcoming = out.scheduleChanges[0]!.upcoming;
      expect(upcoming).toHaveLength(5);
      await waitFor(async () => (await runsOf('c13')).length >= 5, {
        timeoutMs: 90_000,
        message: '다섯 번 발화',
      });
      const fired = (await runsOf('c13'))
        .map((r) => r.scheduledFireTime)
        .sort((a, b) => (a ?? 0) - (b ?? 0))
        .slice(0, 5);
      expect(fired).toEqual(upcoming);
    }, 150_000);
  });
});
