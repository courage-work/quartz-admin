import type { CommandExpected, QuartzCommand } from '@qa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_GROUPS_PAUSED,
  CommandRejection,
  TargetPoolManager,
  createDriverAdapters,
  executeCommand,
  expectedOf,
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
  startQuartzCluster,
  waitFor,
  waitForExecutions,
  type QuartzCluster,
  type TestbedClient,
  type TestbedNode,
  type TriggerSpec,
  TEST_DB_LABEL,
  schedulerContext,
  triggerAccessIsFree,
  type TestConnection,
} from '../support/index.js';

/** 차등 테스트의 두 기준 인스턴스. 같은 초기 상태를 만들고 한쪽은 Quartz API, 다른 쪽은 도구로 명령한다 */
const REF_QUARTZ = 'PauseQuartz';
const REF_TOOL = 'PauseTool';
const T = (name: string) => quartzTableName(name as Parameters<typeof quartzTableName>[0]);
/** 클러스터 노드의 misfireThreshold. 수렴 테스트가 MisfireHandler를 오래 기다리지 않게 줄인다 */
const MISFIRE_THRESHOLD_MS = 5_000;

/**
 * 일시정지와 재개 (B-18·B-23, TRD §7.3·§7.4, 부록 A.2 P-05, A.3, A.4 G-01~G-13, A.8 X-05).
 * 2노드 클러스터와 `start()`하지 않는 기준 인스턴스 두 개를 같은 DB 스키마에 띄운다.
 */
describe(`일시정지와 재개 (${TEST_DB_LABEL}, Quartz ${QUARTZ_VERSION})`, () => {
  let cluster: QuartzCluster;
  let refQuartz: TestbedNode;
  let refTool: TestbedNode;
  let node1: TestbedNode;
  let conn: TestConnection;
  let pools: TargetPoolManager;
  let target: PoolTarget;

  const ctxFor = (schedName: string): SchedulerCommandContext =>
    schedulerContext(cluster.db, schedName);

  const run = <R>(fn: (c: TargetConn) => Promise<R>) => pools.withConnection(target, fn);

  /**
   * 대상 DB(=노드) 시계 기준 현재 시각. 노드와 DB는 Docker VM 시계를 쓰고 호스트 시계와 몇 초씩 어긋날 수 있어,
   * 실행 기록의 FIRED 시각·NEXT_FIRE_TIME과 비교할 때는 이 값을 쓴다
   */
  let skewMs = 0;
  const now = () => Date.now() + skewMs;
  /** Docker VM 시계는 호스트와 점점 어긋날 수 있어 시각에 민감한 단계 앞에서 다시 맞춘다 */
  const syncClock = async () => {
    skewMs = (await run((c) => queryDbNowMillis(c, cluster.db.dialect))) - Date.now();
  };

  /** 화면처럼 미리보기의 기대 상태를 붙여 실행한다 */
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

  /** TRIGGER_ACCESS가 풀려 있는지(부록 A.1 공통 사후 조건). 클러스터 노드가 잠깐씩 잡으므로 3초까지 기다린다 */
  async function lockIsFree(schedName: string): Promise<boolean> {
    return triggerAccessIsFree(conn, cluster.db, schedName, T('LOCKS'));
  }

  interface TriggerRow {
    state: string;
    nft: number | null;
    timesTriggered: number | null;
    repeatCount: number | null;
  }

  async function row(schedName: string, group: string, name: string): Promise<TriggerRow | null> {
    const res = await conn.execute<[string, number | null, number | null, number | null]>(
      `SELECT t.TRIGGER_STATE, t.NEXT_FIRE_TIME, s.TIMES_TRIGGERED, s.REPEAT_COUNT FROM ${T('TRIGGERS')} t ` +
        `LEFT JOIN ${T('SIMPLE_TRIGGERS')} s ON s.SCHED_NAME = t.SCHED_NAME AND s.TRIGGER_GROUP = t.TRIGGER_GROUP ` +
        `AND s.TRIGGER_NAME = t.TRIGGER_NAME ` +
        `WHERE t.SCHED_NAME = :1 AND t.TRIGGER_GROUP = :2 AND t.TRIGGER_NAME = :3`,
      [schedName, group, name],
    );
    const r = res.rows?.[0];
    if (!r) return null;
    const [raw, nft, timesTriggered, repeatCount] = r;
    // WAITING과 ACQUIRED는 노드가 발화 직전에 수시로 오가는 상태라 같은 것으로 본다(TRD §7.1 d)
    const state = raw === 'ACQUIRED' ? 'WAITING' : raw;
    return { state, nft: nft === null || nft <= 0 ? null : nft, timesTriggered, repeatCount };
  }

  const state = async (schedName: string, group: string, name: string) =>
    (await row(schedName, group, name))?.state ?? null;

  async function pausedGroups(schedName: string): Promise<string[]> {
    const res = await conn.execute<[string]>(
      `SELECT TRIGGER_GROUP FROM ${T('PAUSED_TRIGGER_GRPS')} WHERE SCHED_NAME = :1 ORDER BY TRIGGER_GROUP`,
      [schedName],
    );
    return (res.rows ?? []).map(([g]) => g);
  }

  beforeAll(async () => {
    cluster = await startQuartzCluster({
      nodes: 2,
      node: { misfireThresholdMs: MISFIRE_THRESHOLD_MS },
    });
    [refQuartz, refTool] = await Promise.all([
      cluster.addReference(REF_QUARTZ),
      cluster.addReference(REF_TOOL),
    ]);
    node1 = cluster.nodes[0]!;
    conn = await cluster.db.connect();
    pools = new TargetPoolManager(createDriverAdapters());
    target = {
      id: 'pause-resume',
      info: cluster.db.targetInfo(),
    };
    await syncClock();
  });

  afterAll(async () => {
    await pools?.closeAll();
    await conn?.close();
    await cluster?.stop();
  });

  // ── 차등 준비 ───────────────────────────────────────────

  const refs = () => [refQuartz, refTool];

  /**
   * 두 기준 인스턴스에 같은 잡(`job-<group>`)과 트리거를 만든다. 트리거 그룹과 잡 그룹은 `group`이다.
   * 시작 시각을 고정해 NEXT_FIRE_TIME까지 같게 한다
   */
  async function seedBoth(
    group: string,
    options: { triggers?: string[]; nonConcurrent?: boolean; jobs?: string[] } = {},
  ): Promise<void> {
    const startAt = now() + 3_600_000;
    const triggers = options.triggers ?? ['t'];
    const jobs = options.jobs ?? [`job-${group}`];
    for (const ref of refs()) {
      for (const jobName of jobs) {
        await ref.client.addJob({
          name: jobName,
          group,
          type: options.nonConcurrent ? 'NonConcurrentSleepJob' : 'RecordingJob',
          durable: true,
        });
        for (const name of triggers) {
          await ref.client.scheduleJob({
            trigger: {
              name: jobs.length > 1 ? `${name}-${jobName}` : name,
              group,
              startAt,
              intervalMs: 60_000,
              repeatCount: -1,
              forJob: { name: jobName, group },
            },
          });
        }
      }
    }
  }

  /** 두 기준 인스턴스에 같은 SQL을 적용한다. `:sched`가 SCHED_NAME 자리다 */
  async function fixtureBoth(statements: string[]): Promise<void> {
    for (const sched of [REF_QUARTZ, REF_TOOL]) {
      await refQuartz.client.fixtureSql(
        statements.map((s) => s.replaceAll(':sched', `'${sched}'`)),
      );
    }
  }

  const setState = (group: string, name: string, value: string) =>
    `UPDATE ${T('TRIGGERS')} SET TRIGGER_STATE = '${value}' WHERE SCHED_NAME = :sched ` +
    `AND TRIGGER_GROUP = '${group}' AND TRIGGER_NAME = '${name}'`;

  const setNextFire = (group: string, name: string, value: number) =>
    `UPDATE ${T('TRIGGERS')} SET NEXT_FIRE_TIME = ${value} WHERE SCHED_NAME = :sched ` +
    `AND TRIGGER_GROUP = '${group}' AND TRIGGER_NAME = '${name}'`;

  const pausedGroupRow = (group: string) =>
    `INSERT INTO ${T('PAUSED_TRIGGER_GRPS')} (SCHED_NAME, TRIGGER_GROUP) VALUES (:sched, '${group}')`;

  /**
   * FIRED_TRIGGERS 행. `job`을 주면 그 잡을 실행 중(EXECUTING)인 행이고, 없으면 획득만 된 행(JOB_NAME NULL)이다
   */
  const firedRow = (
    group: string,
    entry: string,
    trigger: string,
    job?: { name: string; nonConcurrent: boolean },
  ) =>
    `INSERT INTO ${T('FIRED_TRIGGERS')} (SCHED_NAME, ENTRY_ID, TRIGGER_NAME, TRIGGER_GROUP, INSTANCE_NAME, ` +
    `FIRED_TIME, SCHED_TIME, PRIORITY, STATE, JOB_NAME, JOB_GROUP, IS_NONCONCURRENT, REQUESTS_RECOVERY) ` +
    `VALUES (:sched, '${entry}', '${trigger}', '${group}', 'node-x', 1000, 1000, 5, ` +
    (job
      ? `'EXECUTING', '${job.name}', '${group}', '${job.nonConcurrent ? '1' : '0'}'`
      : `'ACQUIRED', NULL, NULL, '0'`) +
    `, '0')`;

  /** Quartz API와 도구 명령의 결과 행 스냅샷이 같은지 비교한다 */
  async function differential(
    quartz: (client: TestbedClient) => Promise<unknown>,
    command: QuartzCommand,
  ): Promise<CommandOutcome> {
    await quartz(refQuartz.client);
    const out = await toolRun(REF_TOOL, command);
    const [q, t] = await Promise.all([
      refQuartz.client.snapshot(REF_QUARTZ),
      refQuartz.client.snapshot(REF_TOOL),
    ]);
    expect(t).toEqual(q);
    expect(await lockIsFree(REF_TOOL)).toBe(true);
    return out;
  }

  /** 도구로만 확인하는 명령. 두 기준 인스턴스의 행이 계속 같도록 양쪽에 같은 명령을 실행한다 */
  async function toolBoth(command: QuartzCommand): Promise<CommandOutcome> {
    await toolRun(REF_QUARTZ, command);
    return toolRun(REF_TOOL, command);
  }

  const states = (sched: string, group: string, names: string[]) =>
    Promise.all(names.map((n) => state(sched, group, n)));

  // ── 잡 일시정지 (부록 A.2) ─────────────────────────────

  it('P-05 pauseJob: W → P, B → PB, P·E는 그대로 (차등)', async () => {
    const names = ['t1', 't2', 't3', 't4'];
    await seedBoth('p05', { triggers: names, nonConcurrent: true });
    await fixtureBoth([
      setState('p05', 't2', 'BLOCKED'),
      setState('p05', 't3', 'PAUSED'),
      setState('p05', 't4', 'ERROR'),
    ]);
    const job = { group: 'p05', name: 'job-p05' };
    await differential((c) => c.pauseJob(job), { type: 'pauseJob', job });
    expect(await states(REF_TOOL, 'p05', names)).toEqual([
      'PAUSED',
      'PAUSED_BLOCKED',
      'PAUSED',
      'ERROR',
    ]);
  });

  // ── 재개 (부록 A.3) ───────────────────────────────────

  const resume = (group: string, name = 't'): QuartzCommand => ({
    type: 'resumeTrigger',
    trigger: { group, name },
  });
  const quartzResume =
    (group: string, name = 't') =>
    (c: TestbedClient) =>
      c.resumeTrigger({ group, name });

  it('R-01 PAUSED → WAITING, NEXT_FIRE_TIME 그대로 (차등)', async () => {
    await seedBoth('r01');
    await fixtureBoth([setState('r01', 't', 'PAUSED')]);
    const before = await row(REF_TOOL, 'r01', 't');
    await differential(quartzResume('r01'), resume('r01'));
    expect(await row(REF_TOOL, 'r01', 't')).toMatchObject({ state: 'WAITING', nft: before?.nft });
  });

  it('R-02·R-03 동시 실행 금지 잡이 실행 중이면 P·PB → BLOCKED (차등)', async () => {
    for (const [group, from] of [
      ['r02', 'PAUSED'],
      ['r03', 'PAUSED_BLOCKED'],
    ] as const) {
      await seedBoth(group, { nonConcurrent: true });
      await fixtureBoth([
        setState(group, 't', from),
        firedRow(group, `${group}-exe`, 'other', { name: `job-${group}`, nonConcurrent: true }),
      ]);
      await differential(quartzResume(group), resume(group));
      expect(await state(REF_TOOL, group, 't')).toBe('BLOCKED');
    }
  });

  it('R-04·R-05·R-06 실행 기록이 없거나, 동시 실행 허용이거나, 획득만 됐으면 WAITING (차등)', async () => {
    await seedBoth('r04', { nonConcurrent: true });
    await fixtureBoth([setState('r04', 't', 'PAUSED_BLOCKED')]);
    await differential(quartzResume('r04'), resume('r04'));
    expect(await state(REF_TOOL, 'r04', 't')).toBe('WAITING');

    await seedBoth('r05');
    await fixtureBoth([
      setState('r05', 't', 'PAUSED'),
      firedRow('r05', 'r05-exe', 'other', { name: 'job-r05', nonConcurrent: false }),
    ]);
    await differential(quartzResume('r05'), resume('r05'));
    expect(await state(REF_TOOL, 'r05', 't')).toBe('WAITING');

    await seedBoth('r06', { triggers: ['t', 't2'], nonConcurrent: true });
    await fixtureBoth([setState('r06', 't', 'PAUSED'), firedRow('r06', 'r06-acq', 't2')]);
    await differential(quartzResume('r06'), resume('r06'));
    expect(await state(REF_TOOL, 'r06', 't')).toBe('WAITING');
  });

  it('R-07 W·B·E·C는 바꾸지 않는다 (차등)', async () => {
    for (const st of ['WAITING', 'BLOCKED', 'ERROR', 'COMPLETE']) {
      const group = `r07-${st.toLowerCase()}`;
      await seedBoth(group);
      await fixtureBoth([setState(group, 't', st)]);
      const out = await differential(quartzResume(group), resume(group));
      expect(out.changes).toEqual([]);
      expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE']);
    }
  });

  it('R-08 NEXT_FIRE_TIME이 없으면 PAUSED 그대로 (차등)', async () => {
    await seedBoth('r08');
    await fixtureBoth([setState('r08', 't', 'PAUSED'), setNextFire('r08', 't', -1)]);
    const out = await differential(quartzResume('r08'), resume('r08'));
    expect(out.changes).toEqual([]);
    expect(await state(REF_TOOL, 'r08', 't')).toBe('PAUSED');
  });

  it('R-09 그룹이 일시정지돼 있어도 실행 시각이 남았으면 WAITING, 그룹 행은 유지 (차등)', async () => {
    await seedBoth('r09');
    await fixtureBoth([setState('r09', 't', 'PAUSED'), pausedGroupRow('r09')]);
    await differential(quartzResume('r09'), resume('r09'));
    expect(await state(REF_TOOL, 'r09', 't')).toBe('WAITING');
    expect(await pausedGroups(REF_TOOL)).toContain('r09');
  });

  it('R-10 resumeJob: P → B(실행 중 JN), PB → B, E 그대로 (차등)', async () => {
    const names = ['t1', 't2', 't3'];
    await seedBoth('r10', { triggers: names, nonConcurrent: true });
    await fixtureBoth([
      setState('r10', 't1', 'PAUSED'),
      setState('r10', 't2', 'PAUSED_BLOCKED'),
      setState('r10', 't3', 'ERROR'),
      firedRow('r10', 'r10-exe', 'other', { name: 'job-r10', nonConcurrent: true }),
    ]);
    const job = { group: 'r10', name: 'job-r10' };
    await differential((c) => c.resumeJob(job), { type: 'resumeJob', job });
    expect(await states(REF_TOOL, 'r10', names)).toEqual(['BLOCKED', 'BLOCKED', 'ERROR']);
  });

  it('R-11 실행 시각이 임계값 안으로 지났으면 WAITING, NEXT_FIRE_TIME 그대로 (차등)', async () => {
    await seedBoth('r11');
    const nft = now() - 10_000;
    await fixtureBoth([setState('r11', 't', 'PAUSED'), setNextFire('r11', 't', nft)]);
    const out = await differential(quartzResume('r11'), resume('r11'));
    expect(await row(REF_TOOL, 'r11', 't')).toMatchObject({ state: 'WAITING', nft });
    expect(out.warnings.map((w) => w.code)).toEqual(['MISFIRE_DELEGATED']);
  });

  it('R-31·R-32 일시정지된 그룹(또는 전체) 안의 지난 트리거는 RESUME_IN_PAUSED_GROUP, 행은 그대로 (도구)', async () => {
    await seedBoth('r31');
    await fixtureBoth([
      setState('r31', 't', 'PAUSED'),
      setNextFire('r31', 't', now() - 300_000),
      pausedGroupRow('r31'),
    ]);
    const before = await refTool.client.snapshot(REF_TOOL);
    const err = await toolError(REF_TOOL, resume('r31'));
    expect(err).toBeInstanceOf(CommandRejection);
    expect(err).toMatchObject({
      code: 'RESUME_IN_PAUSED_GROUP',
      current: [{ group: 'r31', name: 't' }],
    });
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(before);

    // 전체 일시정지 표시만 있어도 같다. 다른 케이스에 영향이 없도록 끝나면 지운다
    await seedBoth('r32');
    await fixtureBoth([setState('r32', 't', 'PAUSED'), setNextFire('r32', 't', now() - 300_000)]);
    await refTool.client.fixtureSql([
      pausedGroupRow(ALL_GROUPS_PAUSED).replace(':sched', `'${REF_TOOL}'`),
    ]);
    try {
      expect(await toolError(REF_TOOL, resume('r32'))).toMatchObject({
        code: 'RESUME_IN_PAUSED_GROUP',
      });
      expect(await state(REF_TOOL, 'r32', 't')).toBe('PAUSED');
    } finally {
      await refTool.client.fixtureSql([
        `DELETE FROM ${T('PAUSED_TRIGGER_GRPS')} WHERE SCHED_NAME = '${REF_TOOL}' ` +
          `AND TRIGGER_GROUP = '${ALL_GROUPS_PAUSED}'`,
      ]);
    }
    expect(await lockIsFree(REF_TOOL)).toBe(true);
  });

  it('R-33 resumeJob: 트리거 하나라도 거부 대상이면 전체를 거부한다 (도구)', async () => {
    // 같은 잡의 트리거를 두 그룹에 둔다. r33a는 일시정지된 그룹이고 실행 시각이 지났다
    const startAt = now() + 3_600_000;
    for (const ref of refs()) {
      await ref.client.addJob({
        name: 'job-r33',
        group: 'r33',
        type: 'RecordingJob',
        durable: true,
      });
      for (const group of ['r33a', 'r33b']) {
        await ref.client.scheduleJob({
          trigger: {
            name: 't',
            group,
            startAt,
            intervalMs: 60_000,
            forJob: { name: 'job-r33', group: 'r33' },
          },
        });
      }
    }
    await fixtureBoth([
      setState('r33a', 't', 'PAUSED'),
      setNextFire('r33a', 't', now() - 300_000),
      pausedGroupRow('r33a'),
      setState('r33b', 't', 'PAUSED'),
    ]);
    const job = { group: 'r33', name: 'job-r33' };
    const preview = await run((c) =>
      previewCommand(c, ctxFor(REF_TOOL), { type: 'resumeJob', job }),
    );
    expect(preview.plan.rejection?.triggers).toEqual([{ group: 'r33a', name: 't' }]);
    expect(await toolError(REF_TOOL, { type: 'resumeJob', job })).toMatchObject({
      code: 'RESUME_IN_PAUSED_GROUP',
    });
    expect(await state(REF_TOOL, 'r33a', 't')).toBe('PAUSED');
    expect(await state(REF_TOOL, 'r33b', 't')).toBe('PAUSED');
  });

  // ── 그룹 (부록 A.4) ───────────────────────────────────

  const ALL_STATES = [
    'WAITING',
    'ACQUIRED',
    'BLOCKED',
    'PAUSED',
    'PAUSED_BLOCKED',
    'ERROR',
    'COMPLETE',
  ];

  it('G-01·G-05 pauseTriggerGroup 뒤 resumeTriggerGroup (차등)', async () => {
    const names = ALL_STATES.map((_, i) => `t${i}`);
    await seedBoth('g01', { triggers: names });
    await fixtureBoth(ALL_STATES.map((st, i) => setState('g01', `t${i}`, st)));

    const out = await differential((c) => c.pauseTriggers({ group: 'g01' }), {
      type: 'pauseTriggerGroup',
      group: 'g01',
    });
    expect(out.groupChanges).toEqual([{ group: 'g01', paused: true }]);
    expect(await states(REF_TOOL, 'g01', names)).toEqual([
      'PAUSED',
      'PAUSED',
      'PAUSED_BLOCKED',
      'PAUSED',
      'PAUSED_BLOCKED',
      'ERROR',
      'COMPLETE',
    ]);
    expect(await pausedGroups(REF_TOOL)).toContain('g01');

    await differential((c) => c.resumeTriggers({ group: 'g01' }), {
      type: 'resumeTriggerGroup',
      group: 'g01',
    });
    expect(await states(REF_TOOL, 'g01', names)).toEqual([
      'WAITING',
      'WAITING',
      'WAITING',
      'WAITING',
      'WAITING',
      'ERROR',
      'COMPLETE',
    ]);
    expect(await pausedGroups(REF_TOOL)).not.toContain('g01');
  });

  it('G-02·G-03 트리거가 없는 그룹도 그룹 행을 넣고, 다시 일시정지해도 행은 하나 (차등)', async () => {
    const command: QuartzCommand = { type: 'pauseTriggerGroup', group: 'g02' };
    await differential((c) => c.pauseTriggers({ group: 'g02' }), command);
    expect(await pausedGroups(REF_TOOL)).toContain('g02');
    const again = await differential((c) => c.pauseTriggers({ group: 'g02' }), command);
    expect(again.groupChanges).toEqual([]);
    expect((await pausedGroups(REF_TOOL)).filter((g) => g === 'g02')).toHaveLength(1);
  });

  it('G-06 그룹이 일시정지 상태가 아니어도 그룹 재개는 개별 일시정지를 푼다 (차등)', async () => {
    await seedBoth('g06');
    await fixtureBoth([setState('g06', 't', 'PAUSED')]);
    await differential((c) => c.resumeTriggers({ group: 'g06' }), {
      type: 'resumeTriggerGroup',
      group: 'g06',
    });
    expect(await state(REF_TOOL, 'g06', 't')).toBe('WAITING');
  });

  it('G-07 그룹 이름은 =로 비교한다. A_B를 일시정지해도 AXB는 그대로 (도구)', async () => {
    await seedBoth('A_B');
    await seedBoth('AXB');
    await toolBoth({ type: 'pauseTriggerGroup', group: 'A_B' });
    expect(await state(REF_TOOL, 'A_B', 't')).toBe('PAUSED');
    expect(await state(REF_TOOL, 'AXB', 't')).toBe('WAITING');
    const groups = await pausedGroups(REF_TOOL);
    expect(groups).toContain('A_B');
    expect(groups).not.toContain('AXB');
  });

  it('G-08·G-10 잡 그룹 일시정지와 재개. 그룹 행은 넣지 않는다 (차등)', async () => {
    await seedBoth('g08', { jobs: ['ja', 'jb'] });
    const before = await pausedGroups(REF_TOOL);
    const out = await differential((c) => c.pauseJobs({ group: 'g08' }), {
      type: 'pauseJobGroup',
      group: 'g08',
    });
    expect(out.changes.map((c) => c.to)).toEqual(['PAUSED', 'PAUSED']);
    expect(out.warnings.map((w) => w.code)).toEqual(['JOB_GROUP_NOT_STORED']);
    expect(await pausedGroups(REF_TOOL)).toEqual(before);

    await differential((c) => c.resumeJobs({ group: 'g08' }), {
      type: 'resumeJobGroup',
      group: 'g08',
    });
    expect(await states(REF_TOOL, 'g08', ['t-ja', 't-jb'])).toEqual(['WAITING', 'WAITING']);
  });

  // ── 스케줄러 전체 (B-23, 부록 A.4 G-11·G-13) ─────────────
  // 기준 인스턴스의 모든 그룹을 바꾸므로 기준 인스턴스를 쓰는 테스트 중 맨 뒤에 둔다.
  // 앞 테스트가 남긴 그룹(트리거 없는 g02 행 등)까지 Quartz와 같게 바뀌는지 함께 비교된다

  it('G-11·G-13 pauseAll 뒤 resumeAll. 트리거가 없는 그룹 행은 남는다 (차등)', async () => {
    await seedBoth('g11a', { triggers: ['t', 'late'] });
    await seedBoth('g11b', { nonConcurrent: true });
    await fixtureBoth([
      // G2: 같은 잡이 동시 실행 금지로 실행 중이라 BLOCKED
      setState('g11b', 't', 'BLOCKED'),
      firedRow('g11b', 'e-g11b', 't', { name: 'job-g11b', nonConcurrent: true }),
      // 실행 시각이 지난 트리거. 전체 재개는 전체 표시까지 지우므로 거부하지 않는다
      setNextFire('g11a', 'late', now() - 600_000),
      pausedGroupRow('g11empty'),
    ]);

    const paused = await differential((c) => c.pauseAll(), { type: 'pauseAll' });
    expect(await states(REF_TOOL, 'g11a', ['t', 'late'])).toEqual(['PAUSED', 'PAUSED']);
    expect(await state(REF_TOOL, 'g11b', 't')).toBe('PAUSED_BLOCKED');
    expect(await pausedGroups(REF_TOOL)).toEqual(
      expect.arrayContaining(['g11a', 'g11b', 'g11empty', ALL_GROUPS_PAUSED]),
    );
    expect(paused.groupChanges).toContainEqual({ group: ALL_GROUPS_PAUSED, paused: true });

    const resumed = await differential((c) => c.resumeAll(), { type: 'resumeAll' });
    expect(await states(REF_TOOL, 'g11a', ['t', 'late'])).toEqual(['WAITING', 'WAITING']);
    expect(await state(REF_TOOL, 'g11b', 't')).toBe('BLOCKED');
    const left = await pausedGroups(REF_TOOL);
    expect(left).toContain('g11empty');
    expect(left).not.toContain('g11a');
    expect(left).not.toContain(ALL_GROUPS_PAUSED);
    expect(resumed.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['PAUSED_GROUPS_KEPT', 'MISFIRE_DELEGATED']),
    );
  });

  // ── 실제 클러스터 ─────────────────────────────────────

  describe('2노드 클러스터', () => {
    const sched = () => cluster.schedulerName;

    const firedAfter = async (group: string, after: number, triggerName?: string) =>
      (
        await listExecutions(conn, {
          schedName: sched(),
          triggerGroup: group,
          ...(triggerName ? { triggerName } : {}),
        })
      ).filter((r) => r.fireTime > after);

    it('일시정지한 트리거는 발화하지 않고, 재개하면 다시 발화한다', async () => {
      await node1.client.scheduleJob({
        job: { name: 'job-live', group: 'live', type: 'RecordingJob', durable: true },
        trigger: { name: 'live', group: 'live', intervalMs: 1_000 },
      });
      await waitForExecutions(conn, { schedName: sched(), triggerName: 'live' });

      const paused = await toolRun(sched(), {
        type: 'pauseTrigger',
        trigger: { group: 'live', name: 'live' },
      });
      await sleep(3_000);
      expect(await firedAfter('live', paused.dbNow)).toEqual([]);

      const resumed = await toolRun(sched(), resume('live', 'live'));
      expect(resumed.after.triggers[0]?.state).toBe('WAITING');
      await waitFor(async () => (await firedAfter('live', resumed.dbNow)).length >= 2, {
        timeoutMs: 20_000,
        message: '재개 뒤 발화',
      });
      expect(await lockIsFree(sched())).toBe(true);
    }, 60_000);

    it('G-04 일시정지한 그룹에 새로 추가한 트리거도 일시정지된다 (통합)', async () => {
      await node1.client.scheduleJob({
        job: { name: 'job-g04', group: 'g04', type: 'RecordingJob', durable: true },
        trigger: { name: 't', group: 'g04', startAt: now() + 3_600_000, intervalMs: 60_000 },
      });
      await toolRun(sched(), { type: 'pauseTriggerGroup', group: 'g04' });
      await node1.client.scheduleJob({
        trigger: {
          name: 'added',
          group: 'g04',
          intervalMs: 1_000,
          forJob: { name: 'job-g04', group: 'g04' },
        },
      });
      expect(await state(sched(), 'g04', 'added')).toBe('PAUSED');
      await sleep(2_000);
      expect(await firedAfter('g04', 0)).toEqual([]);
    }, 60_000);

    it('G-09 잡 그룹 일시정지는 저장되지 않아 새 잡의 트리거는 WAITING (통합)', async () => {
      await node1.client.scheduleJob({
        job: { name: 'a', group: 'g09', type: 'RecordingJob', durable: true },
        trigger: { name: 'a', group: 'g09', startAt: now() + 3_600_000, intervalMs: 60_000 },
      });
      await toolRun(sched(), { type: 'pauseJobGroup', group: 'g09' });
      expect(await state(sched(), 'g09', 'a')).toBe('PAUSED');
      await node1.client.scheduleJob({
        job: { name: 'b', group: 'g09', type: 'RecordingJob', durable: true },
        trigger: { name: 'b', group: 'g09', startAt: now() + 3_600_000, intervalMs: 60_000 },
      });
      expect(await state(sched(), 'g09', 'b')).toBe('WAITING');
    }, 60_000);

    it('X-05 트리거 50개가 계속 발화하는 그룹을 20번 일시정지해도 매번 성공하거나 TARGET_ERROR이고, 성공 뒤에는 발화하지 않는다', async () => {
      await node1.client.addJob({
        name: 'job-x05',
        group: 'x05',
        type: 'RecordingJob',
        durable: true,
      });
      for (let i = 0; i < 50; i++) {
        await node1.client.scheduleJob({
          trigger: {
            name: `t${i}`,
            group: 'x05',
            intervalMs: 1_000,
            forJob: { name: 'job-x05', group: 'x05' },
          },
        });
      }
      await waitFor(async () => (await firedAfter('x05', 0)).length >= 50, {
        timeoutMs: 30_000,
        message: '그룹 발화 시작',
      });

      let succeeded = 0;
      for (let round = 0; round < 20; round++) {
        const out = await toolRun(sched(), { type: 'pauseTriggerGroup', group: 'x05' }).catch(
          (e: unknown) => e,
        );
        if (out instanceof Error) {
          expect(out).toMatchObject({ code: 'TARGET_ERROR' });
          // 실패한 회차는 아무것도 바꾸지 않았다
          expect(await pausedGroups(sched())).not.toContain('x05');
        } else {
          succeeded++;
          const lockedAt = (out as CommandOutcome).dbNow;
          await sleep(1_500);
          expect(await firedAfter('x05', lockedAt)).toEqual([]);
          await toolRun(sched(), { type: 'resumeTriggerGroup', group: 'x05' });
        }
        await sleep(1_000);
      }
      expect(succeeded).toBeGreaterThan(0);
      await toolRun(sched(), { type: 'pauseTriggerGroup', group: 'x05' });
      expect(await lockIsFree(sched())).toBe(true);
    }, 240_000);

    // ── 수렴: 재개 뒤 misfire 처리를 노드에 맡겨도 Quartz와 결과가 같다 (부록 A.3 R-21~R-26) ──

    /** 분의 `from`~`to`초 사이가 될 때까지 기다린다. 1분 주기 트리거의 다음 실행 시각이 두 쌍둥이에서 같게 한다 */
    async function waitForSecond(from: number, to: number): Promise<void> {
      await syncClock();
      for (;;) {
        const s = new Date(now()).getSeconds();
        if (s >= from && s <= to) return;
        await sleep(500);
      }
    }

    let twinSeq = 0;

    /**
     * 같은 설정의 일시정지된 트리거 두 개(Quartz 쪽 `q`, 도구 쪽 `t`)를 만들고 실행 시각을 5분 전으로 돌린다.
     * 그룹을 먼저 일시정지해 저장 즉시 PAUSED가 되게 하고, 만든 뒤 그룹 행을 지운다(그룹 일시정지 안의 재개가 아니게).
     */
    async function twins(
      trigger: (name: string, group: string) => TriggerSpec,
      fixture: (group: string) => string[] = () => [],
    ): Promise<string> {
      const group = `conv${++twinSeq}`;
      await node1.client.pauseTriggers({ group });
      await node1.client.addJob({
        name: `job-${group}`,
        group,
        type: 'RecordingJob',
        durable: true,
      });
      for (const name of ['q', 't']) {
        await node1.client.scheduleJob({
          trigger: { ...trigger(name, group), forJob: { name: `job-${group}`, group } },
        });
      }
      const past = Math.floor(now() / 60_000) * 60_000 - 300_000;
      await node1.client.fixtureSql([
        `DELETE FROM ${T('PAUSED_TRIGGER_GRPS')} WHERE SCHED_NAME = '${sched()}' AND TRIGGER_GROUP = '${group}'`,
        `UPDATE ${T('TRIGGERS')} SET NEXT_FIRE_TIME = ${past} WHERE SCHED_NAME = '${sched()}' AND TRIGGER_GROUP = '${group}'`,
        ...fixture(group).map((s) => s.replaceAll(':sched', `'${sched()}'`)),
      ]);
      expect(await states(sched(), group, ['q', 't'])).toEqual(['PAUSED', 'PAUSED']);
      return group;
    }

    /** `q`는 실행 중인 노드의 Quartz `resumeTrigger`(바로 misfire 처리), `t`는 도구로 재개하고 둘 다 처리될 때까지 기다린다 */
    async function resumeTwins(group: string): Promise<{ q: TriggerRow; t: TriggerRow }> {
      await syncClock();
      await node1.client.resumeTrigger({ group, name: 'q' });
      const out = await toolRun(sched(), resume(group, 't'));
      expect(out.changes).toHaveLength(1);
      const settled = (r: TriggerRow | null) =>
        r !== null &&
        (r.state === 'COMPLETE' || (r.nft !== null && r.nft >= now() - MISFIRE_THRESHOLD_MS));
      await waitFor(
        async () =>
          settled(await row(sched(), group, 'q')) && settled(await row(sched(), group, 't')),
        { timeoutMs: MISFIRE_THRESHOLD_MS * 4, message: 'misfire 처리' },
      );
      // 바로 발화하는 정책은 두 쪽의 실행 기록이 남을 때까지 둔다
      await sameRuns(group);
      const [q, t] = await Promise.all([row(sched(), group, 'q'), row(sched(), group, 't')]);
      return { q: q!, t: t! };
    }

    /** 쌍둥이 트리거는 일시정지된 채 만들어 재개 전에는 발화한 적이 없다. 그래서 시각 없이 전체 실행 수를 센다 */
    const runs = async (group: string, name: string) => (await firedAfter(group, 0, name)).length;

    /** 예정 시각이 `before`보다 이른 실행 수(그 뒤의 정상 발화는 빼고 센다) */
    const runsBefore = async (group: string, name: string, before: number) =>
      (await firedAfter(group, 0, name)).filter((r) => (r.scheduledFireTime ?? r.fireTime) < before)
        .length;

    /**
     * 두 쪽의 실행 수가 같아지고 2초 동안 그대로일 때까지 기다린다(최대 15초). 마지막으로 함께 센 값을 돌려준다.
     * 끝내 다르면 다른 값이 돌아와 비교가 실패한다. 짧은 주기 트리거는 따로 다시 세면 그 사이 다음 회차가 낄 수 있어 이 값으로 비교한다
     */
    async function sameRuns(group: string): Promise<{ q: number; t: number }> {
      const deadline = Date.now() + 15_000;
      let stableSince = 0;
      let last = { q: -1, t: -2 };
      while (Date.now() < deadline) {
        const [q, t] = await Promise.all([runs(group, 'q'), runs(group, 't')]);
        last = { q, t };
        if (q === t) {
          stableSince ||= Date.now();
          if (Date.now() - stableSince >= 2_000) return last;
        } else {
          stableSince = 0;
        }
        await sleep(500);
      }
      return last;
    }

    it('R-21·R-22 CRON 재개: FIRE_ONCE_NOW는 한 번 실행, DO_NOTHING은 실행 없이 다음 시각 (수렴)', async () => {
      for (const misfire of ['SMART_POLICY', 'FIRE_ONCE_NOW', 'DO_NOTHING']) {
        const group = await twins((name, g) => ({
          type: 'cron',
          name,
          group: g,
          cron: '0 * * * * ?',
          misfire,
        }));
        await waitForSecond(5, 35);
        // misfire 처리와 실행 수 안정화를 기다리다 다음 분 0초를 넘기면 정상 발화가 한 번 더 기록된다(MariaDB에서 실패).
        // 그래서 재개 시점의 다음 분보다 이른 예정 시각으로 실행된 것, 곧 misfire 처리로 실행된 것만 센다
        const nextMinute = Math.ceil(now() / 60_000) * 60_000;
        const { q, t } = await resumeTwins(group);
        expect(t).toEqual(q);
        const expectedRuns = misfire === 'DO_NOTHING' ? 0 : 1;
        expect(await runsBefore(group, 'q', nextMinute)).toBe(expectedRuns);
        expect(await runsBefore(group, 't', nextMinute)).toBe(expectedRuns);
      }
    }, 240_000);

    it('R-23 SIMPLE 재개: misfire 정책 6종의 결과가 Quartz와 같다 (수렴)', async () => {
      const policies = [
        'SMART_POLICY',
        'FIRE_NOW',
        'RESCHEDULE_NOW_WITH_EXISTING_REPEAT_COUNT',
        'RESCHEDULE_NOW_WITH_REMAINING_REPEAT_COUNT',
        'RESCHEDULE_NEXT_WITH_REMAINING_COUNT',
        'RESCHEDULE_NEXT_WITH_EXISTING_COUNT',
      ];
      for (const misfire of policies) {
        const startAt = Math.floor(now() / 60_000) * 60_000 - 600_000;
        const group = await twins((name, g) => ({
          name,
          group: g,
          startAt,
          intervalMs: 60_000,
          repeatCount: -1,
          misfire,
        }));
        await waitForSecond(5, 35);
        const { q, t } = await resumeTwins(group);
        expect({ ...t, nft: null }).toEqual({ ...q, nft: null });
        // 반복하는 SimpleTrigger의 FIRE_NOW는 Quartz가 RESCHEDULE_NOW_WITH_REMAINING_REPEAT_COUNT로 바꾼다
        // (`SimpleTriggerImpl.updateAfterMisfire`)
        if (misfire === 'FIRE_NOW' || misfire.startsWith('RESCHEDULE_NOW')) {
          // 지금을 시작 시각으로 다시 잡는 정책은 처리한 시각만큼 다음 실행 시각이 다르다
          expect(Math.abs((t.nft ?? 0) - (q.nft ?? 0))).toBeLessThanOrEqual(
            MISFIRE_THRESHOLD_MS * 3,
          );
        } else {
          expect(t.nft).toBe(q.nft);
        }
        expect(await runs(group, 't')).toBe(await runs(group, 'q'));
      }
    }, 600_000);

    it('R-24 SIMPLE IGNORE_MISFIRE_POLICY는 MisfireHandler 없이 놓친 실행을 따라잡는다 (수렴)', async () => {
      const group = await twins((name, g) => ({
        name,
        group: g,
        startAt: Math.floor(now() / 60_000) * 60_000 - 600_000,
        intervalMs: 10_000,
        repeatCount: -1,
        misfire: 'IGNORE_MISFIRE_POLICY',
      }));
      await node1.client.fixtureSql([
        `UPDATE ${T('TRIGGERS')} SET NEXT_FIRE_TIME = ${Math.floor(now() / 10_000) * 10_000 - 60_000} ` +
          `WHERE SCHED_NAME = '${sched()}' AND TRIGGER_GROUP = '${group}'`,
      ]);
      await syncClock();
      await node1.client.resumeTrigger({ group, name: 'q' });
      await toolRun(sched(), resume(group, 't'));
      await waitFor(
        async () => {
          const [q, t] = await Promise.all([row(sched(), group, 'q'), row(sched(), group, 't')]);
          return !!q?.nft && !!t?.nft && q.nft > now() && t.nft > now();
        },
        { timeoutMs: 30_000, message: '따라잡기' },
      );
      // 10초마다 둘 다 발화하므로 실행 수는 sameRuns가 함께 센 값으로 비교한다(XE 21 × 2.3.2에서 따로 세다 7 대 8)
      const counted = await sameRuns(group);
      const [q, t] = await Promise.all([row(sched(), group, 'q'), row(sched(), group, 't')]);
      expect(t).toEqual(q);
      expect(counted.t).toBe(counted.q);
      expect(counted.t).toBeGreaterThanOrEqual(6);
    }, 60_000);

    it('R-25 SIMPLE 남은 횟수가 지난 RESCHEDULE_NEXT_WITH_REMAINING_COUNT는 COMPLETE (수렴)', async () => {
      const group = await twins(
        (name, g) => ({
          name,
          group: g,
          startAt: Math.floor(now() / 60_000) * 60_000 - 600_000,
          intervalMs: 10_000,
          repeatCount: 2,
          misfire: 'RESCHEDULE_NEXT_WITH_REMAINING_COUNT',
        }),
        (g) => [
          `UPDATE ${T('SIMPLE_TRIGGERS')} SET TIMES_TRIGGERED = 1 WHERE SCHED_NAME = :sched AND TRIGGER_GROUP = '${g}'`,
        ],
      );
      const { q, t } = await resumeTwins(group);
      expect(t).toEqual(q);
      expect(t.state).toBe('COMPLETE');
      expect(t.nft).toBeNull();
      expect(await runs(group, 't')).toBe(0);
    }, 60_000);

    it('R-26 동시 실행 금지 잡이 실행 중이면 BLOCKED로 재개되고, 잡이 끝난 뒤 misfire 처리된다 (수렴)', async () => {
      await node1.client.addJob({
        name: 'job-r26',
        group: 'r26',
        type: 'NonConcurrentSleepJob',
        durable: true,
        data: { sleepSeconds: 10 },
      });
      await node1.client.pauseTriggers({ group: 'r26' });
      await node1.client.scheduleJob({
        trigger: {
          type: 'cron',
          name: 't',
          group: 'r26',
          cron: '0 * * * * ?',
          forJob: { name: 'job-r26', group: 'r26' },
        },
      });
      await node1.client.fixtureSql([
        `DELETE FROM ${T('PAUSED_TRIGGER_GRPS')} WHERE SCHED_NAME = '${sched()}' AND TRIGGER_GROUP = 'r26'`,
        `UPDATE ${T('TRIGGERS')} SET NEXT_FIRE_TIME = ${now() - 300_000} WHERE SCHED_NAME = '${sched()}' AND TRIGGER_GROUP = 'r26'`,
      ]);
      // 다른 그룹의 트리거로 잡을 실행시켜 둔다
      await node1.client.scheduleJob({
        trigger: { name: 'runner', group: 'r26-run', forJob: { name: 'job-r26', group: 'r26' } },
      });
      await waitFor(
        async () =>
          (await node1.client.currentlyExecutingJobs()).some((j) => j.jobName === 'job-r26') ||
          (await cluster.nodes[1]!.client.currentlyExecutingJobs()).some(
            (j) => j.jobName === 'job-r26',
          ),
        { timeoutMs: 20_000, message: '잡 실행 시작' },
      );
      // 잡이 실행되면 Quartz가 같은 잡의 일시정지된 트리거를 PAUSED_BLOCKED로 바꾼다(`JSS.triggerFired`)
      const before = await row(sched(), 'r26', 't');
      expect(before?.state).toBe('PAUSED_BLOCKED');
      const out = await toolRun(sched(), resume('r26'));
      expect(out.changes).toEqual([
        { group: 'r26', name: 't', from: 'PAUSED_BLOCKED', to: 'BLOCKED' },
      ]);
      expect(await row(sched(), 'r26', 't')).toMatchObject({ state: 'BLOCKED', nft: before?.nft });

      await waitFor(
        async () => {
          const r = await row(sched(), 'r26', 't');
          return r?.state === 'WAITING' && r.nft !== null && r.nft >= now() - MISFIRE_THRESHOLD_MS;
        },
        { timeoutMs: 60_000, message: '잡 종료 뒤 misfire 처리' },
      );
    }, 120_000);

    // 클러스터 스케줄러 전체를 멈추므로 클러스터 테스트 중 맨 뒤에 둔다
    it('G-12 전체 일시정지 중 새 그룹에 추가한 트리거도 일시정지되고, 전체 재개하면 발화한다 (통합)', async () => {
      await toolRun(sched(), { type: 'pauseAll' });
      await node1.client.scheduleJob({
        job: { name: 'job-g12', group: 'g12', type: 'RecordingJob', durable: true },
        trigger: { name: 'added', group: 'g12', intervalMs: 1_000 },
      });
      // Quartz가 트리거를 저장할 때 전체 표시를 보고 그룹 행을 넣는다(TRD §7.3 "트리거 저장 시 상태 결정")
      expect(await state(sched(), 'g12', 'added')).toBe('PAUSED');
      expect(await pausedGroups(sched())).toEqual(
        expect.arrayContaining(['g12', ALL_GROUPS_PAUSED]),
      );
      await sleep(2_000);
      expect(await firedAfter('g12', 0)).toEqual([]);

      const resumed = await toolRun(sched(), { type: 'resumeAll' });
      await waitFor(async () => (await firedAfter('g12', resumed.dbNow)).length >= 1, {
        timeoutMs: 20_000,
        message: '전체 재개 뒤 발화',
      });
      expect(await pausedGroups(sched())).not.toContain(ALL_GROUPS_PAUSED);
      expect(await lockIsFree(sched())).toBe(true);
    }, 60_000);
  });
});
