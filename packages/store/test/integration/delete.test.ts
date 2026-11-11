import type { CommandExpected, QuartzCommand } from '@qa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
  startQuartzCluster,
  waitFor,
  type QuartzCluster,
  type TestbedClient,
  type TestbedNode,
  TEST_DB,
  TEST_DB_LABEL,
  schedulerContext,
  triggerAccessIsFree,
  type TestConnection,
} from '../support/index.js';

/** DB마다 BLOB 바이트(Java 직렬화 머리 ACED0005)를 쓰는 리터럴 */
const BLOB_LITERAL = {
  oracle: "HEXTORAW('ACED0005')",
  postgres: "decode('ACED0005', 'hex')",
  mysql: "X'ACED0005'",
} as const;

/** 차등 테스트의 두 기준 인스턴스. 같은 초기 상태를 만들고 한쪽은 Quartz API, 다른 쪽은 도구로 명령한다 */
const REF_QUARTZ = 'DeleteQuartz';
const REF_TOOL = 'DeleteTool';
const T = (name: string) => quartzTableName(name as Parameters<typeof quartzTableName>[0]);

/**
 * 트리거·잡 삭제 (B-21, TRD §7.3, 부록 A.7 D-01~D-07, DJ-01~DJ-03).
 * 2노드 클러스터와 `start()`하지 않는 기준 인스턴스 두 개를 같은 DB 스키마에 띄운다.
 */
describe(`삭제 (${TEST_DB_LABEL}, Quartz ${QUARTZ_VERSION})`, () => {
  let cluster: QuartzCluster;
  let refQuartz: TestbedNode;
  let refTool: TestbedNode;
  let conn: TestConnection;
  let pools: TargetPoolManager;
  let target: PoolTarget;

  const ctxFor = (schedName: string): SchedulerCommandContext =>
    schedulerContext(cluster.db, schedName);

  const run = <R>(fn: (c: TargetConn) => Promise<R>) => pools.withConnection(target, fn);
  const dbNow = () => run((c) => queryDbNowMillis(c, cluster.db.dialect));

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

  async function lockIsFree(schedName: string): Promise<boolean> {
    return triggerAccessIsFree(conn, cluster.db, schedName, T('LOCKS'));
  }

  async function count(sql: string, binds: unknown[]): Promise<number> {
    const res = await conn.execute<[number]>(sql, binds);
    return res.rows?.[0]?.[0] ?? 0;
  }

  const triggerRows = (schedName: string, group: string, name: string) =>
    count(
      `SELECT COUNT(*) FROM ${T('TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = :2 AND TRIGGER_NAME = :3`,
      [schedName, group, name],
    );
  const jobRows = (schedName: string, group: string, name: string) =>
    count(
      `SELECT COUNT(*) FROM ${T('JOB_DETAILS')} WHERE SCHED_NAME = :1 AND JOB_GROUP = :2 AND JOB_NAME = :3`,
      [schedName, group, name],
    );
  const firedRows = (schedName: string, group: string, name: string) =>
    count(
      `SELECT COUNT(*) FROM ${T('FIRED_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = :2 AND TRIGGER_NAME = :3`,
      [schedName, group, name],
    );

  /** 실행이 실제로 시작될 때까지(획득만 된 ACQUIRED가 아니라 EXECUTING) 기다린다 */
  const waitExecuting = (schedName: string, group: string, name: string) =>
    waitFor(
      async () =>
        (await count(
          `SELECT COUNT(*) FROM ${T('FIRED_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = :2 ` +
            `AND TRIGGER_NAME = :3 AND STATE = 'EXECUTING'`,
          [schedName, group, name],
        )) > 0,
      { timeoutMs: 30_000, message: '실행 시작' },
    );

  beforeAll(async () => {
    cluster = await startQuartzCluster({ nodes: 2 });
    [refQuartz, refTool] = await Promise.all([
      cluster.addReference(REF_QUARTZ),
      cluster.addReference(REF_TOOL),
    ]);
    conn = await cluster.db.connect();
    pools = new TargetPoolManager(createDriverAdapters());
    target = {
      id: 'delete',
      info: cluster.db.targetInfo(),
    };
  });

  afterAll(async () => {
    await pools?.closeAll();
    await conn?.close();
    await cluster?.stop();
  });

  // ── 차등 준비 ───────────────────────────────────────────

  const refs = () => [refQuartz, refTool];
  const later = () => Date.now() + 3_600_000;

  /** 두 기준 인스턴스에 잡(`job-<group>`)과 트리거들을 만든다 */
  async function seedBoth(
    group: string,
    options: { durable?: boolean; triggers?: { name: string; cron?: boolean }[] } = {},
  ): Promise<void> {
    const durable = options.durable ?? true;
    const triggers = options.triggers ?? [{ name: 't' }];
    const startAt = later();
    for (const ref of refs()) {
      const [first, ...rest] = triggers;
      const spec = (t: { name: string; cron?: boolean }) =>
        t.cron
          ? { type: 'cron' as const, name: t.name, group, cron: '0 0 12 * * ?', timeZone: 'UTC' }
          : { name: t.name, group, startAt, intervalMs: 60_000 };
      if (first) {
        await ref.client.scheduleJob({
          job: { name: `job-${group}`, group, type: 'RecordingJob', durable },
          trigger: spec(first),
        });
      } else {
        await ref.client.addJob({
          name: `job-${group}`,
          group,
          type: 'RecordingJob',
          durable: true,
        });
      }
      for (const t of rest) {
        await ref.client.scheduleJob({
          trigger: { ...spec(t), forJob: { name: `job-${group}`, group } },
        });
      }
    }
  }

  async function fixtureBoth(statements: string[]): Promise<void> {
    for (const sched of [REF_QUARTZ, REF_TOOL]) {
      await refQuartz.client.fixtureSql(
        statements.map((s) => s.replaceAll(':sched', `'${sched}'`)),
      );
    }
  }

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

  const delTrigger = (group: string, name = 't'): QuartzCommand => ({
    type: 'deleteTrigger',
    trigger: { group, name },
  });
  const unschedule =
    (group: string, name = 't') =>
    (c: TestbedClient) =>
      c.unscheduleJob({ group, name });

  // ── 트리거 삭제 (부록 A.7) ───────────────────────────────

  it('D-01 durable 잡의 유일한 CRON 트리거: 트리거와 CRON_TRIGGERS만 지우고 잡은 남는다 (차등)', async () => {
    await seedBoth('d01', { triggers: [{ name: 't', cron: true }] });
    const out = await differential(unschedule('d01'), delTrigger('d01'));
    expect(out.deletions).toEqual({ triggers: [{ group: 'd01', name: 't' }], jobs: [] });
    expect(await triggerRows(REF_TOOL, 'd01', 't')).toBe(0);
    expect(await jobRows(REF_TOOL, 'd01', 'job-d01')).toBe(1);
  });

  it('D-02·D-03 durable이 아닌 잡은 마지막 트리거를 지울 때만 잡도 지운다 (차등)', async () => {
    await seedBoth('d02', { durable: false });
    const out = await differential(unschedule('d02'), delTrigger('d02'));
    expect(out.warnings.map((w) => w.code)).toContain('JOB_ALSO_DELETED');
    expect(await jobRows(REF_TOOL, 'd02', 'job-d02')).toBe(0);
    expect(out.snapshot).toMatchObject({ trigger: { name: 't' }, job: { durable: false } });

    await seedBoth('d03', { durable: false, triggers: [{ name: 't' }, { name: 't2' }] });
    const out3 = await differential(unschedule('d03'), delTrigger('d03'));
    expect(out3.deletions.jobs).toEqual([]);
    expect(await jobRows(REF_TOOL, 'd03', 'job-d03')).toBe(1);
  });

  it('D-04 CAL_INT(SIMPROP)과 사용자 정의(BLOB) 트리거도 하위 행과 함께 지운다 (차등)', async () => {
    await seedBoth('d04', { triggers: [] });
    const insertTrigger = (name: string, type: string) =>
      `INSERT INTO ${T('TRIGGERS')} (SCHED_NAME, TRIGGER_NAME, TRIGGER_GROUP, JOB_NAME, JOB_GROUP, ` +
      `NEXT_FIRE_TIME, PREV_FIRE_TIME, PRIORITY, TRIGGER_STATE, TRIGGER_TYPE, START_TIME, END_TIME, MISFIRE_INSTR) ` +
      `VALUES (:sched, '${name}', 'd04', 'job-d04', 'd04', ${later()}, -1, 5, 'WAITING', '${type}', ${later()}, 0, 0)`;
    await fixtureBoth([
      insertTrigger('cal', 'CAL_INT'),
      `INSERT INTO ${T('SIMPROP_TRIGGERS')} (SCHED_NAME, TRIGGER_NAME, TRIGGER_GROUP, STR_PROP_1, INT_PROP_1) ` +
        `VALUES (:sched, 'cal', 'd04', 'MINUTE', 5)`,
      insertTrigger('blob', 'BLOB'),
      `INSERT INTO ${T('BLOB_TRIGGERS')} (SCHED_NAME, TRIGGER_NAME, TRIGGER_GROUP, BLOB_DATA) ` +
        `VALUES (:sched, 'blob', 'd04', ${BLOB_LITERAL[TEST_DB]})`,
    ]);
    await differential(unschedule('d04', 'cal'), delTrigger('d04', 'cal'));
    await differential(unschedule('d04', 'blob'), delTrigger('d04', 'blob'));
    const left =
      (await count(
        `SELECT COUNT(*) FROM ${T('SIMPROP_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = 'd04'`,
        [REF_TOOL],
      )) +
      (await count(
        `SELECT COUNT(*) FROM ${T('BLOB_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = 'd04'`,
        [REF_TOOL],
      ));
    expect(left).toBe(0);
  });

  it('D-07 그룹의 마지막 트리거를 지워도 그룹 일시정지 행은 남는다 (차등)', async () => {
    await seedBoth('d07');
    await refQuartz.client.pauseTriggers({ group: 'd07' });
    await toolRun(REF_TOOL, { type: 'pauseTriggerGroup', group: 'd07' });
    await differential(unschedule('d07'), delTrigger('d07'));
    expect(
      await count(
        `SELECT COUNT(*) FROM ${T('PAUSED_TRIGGER_GRPS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = 'd07'`,
        [REF_TOOL],
      ),
    ).toBe(1);
  });

  // ── 잡 삭제 (부록 A.7) ───────────────────────────────────

  it('DJ-01·DJ-03 잡의 모든 트리거와 하위 행, 잡을 지운다. 트리거 없는 durable 잡도 지운다 (차등)', async () => {
    await seedBoth('dj01', { triggers: [{ name: 't1', cron: true }, { name: 't2' }] });
    const job = { group: 'dj01', name: 'job-dj01' };
    const out = await differential((c) => c.deleteJob(job), { type: 'deleteJob', job });
    expect(out.deletions.triggers).toHaveLength(2);
    expect(out.snapshot).toMatchObject({
      job: { group: 'dj01', name: 'job-dj01' },
      triggers: [
        { name: 't1', type: 'CRON' },
        { name: 't2', type: 'SIMPLE' },
      ],
    });
    expect(typeof out.snapshot?.jobDataBytes).toBe('number');
    expect(await jobRows(REF_TOOL, 'dj01', 'job-dj01')).toBe(0);

    await seedBoth('dj03', { triggers: [] });
    const empty = { group: 'dj03', name: 'job-dj03' };
    await differential((c) => c.deleteJob(empty), { type: 'deleteJob', job: empty });
    expect(await jobRows(REF_TOOL, 'dj03', 'job-dj03')).toBe(0);
  });

  it('없는 트리거·잡은 NOT_FOUND, 행은 그대로 (도구)', async () => {
    const before = await refTool.client.snapshot(REF_TOOL);
    for (const command of [
      delTrigger('none'),
      { type: 'deleteJob', job: { group: 'none', name: 'none' } } as QuartzCommand,
    ]) {
      const err = await toolRun(REF_TOOL, command, { triggers: [], pausedGroups: [] }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CommandRejection);
      expect(err).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(before);
  });

  // ── 실제 클러스터 (부록 A.7 D-05, D-06, DJ-02) ───────────────

  describe('2노드 클러스터', () => {
    const sched = () => cluster.schedulerName;
    const node = () => cluster.nodes[0]!.client;

    it('D-05 집힌 트리거를 지우면 발화하지 않고 노드가 획득 기록을 지운다 (통합)', async () => {
      await node().addJob({ name: 'job-d05', group: 'd05', type: 'RecordingJob', durable: true });
      await node().scheduleJob({
        trigger: {
          type: 'cron',
          name: 't',
          group: 'd05',
          cron: '0 * * * * ?',
          timeZone: 'UTC',
          forJob: { name: 'job-d05', group: 'd05' },
        },
      });
      let oldFire = 0;
      await waitFor(
        async () => {
          const res = await conn.execute<[string, number]>(
            `SELECT TRIGGER_STATE, NEXT_FIRE_TIME FROM ${T('TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = 'd05'`,
            [sched()],
          );
          const r = res.rows?.[0];
          if (r?.[0] !== 'ACQUIRED' || r[1] - (await dbNow()) < 4_000) return false;
          oldFire = r[1];
          return true;
        },
        { timeoutMs: 90_000, intervalMs: 200, message: '노드가 트리거를 집음' },
      );
      await toolRun(sched(), delTrigger('d05'));
      await waitFor(async () => (await dbNow()) > oldFire + 3_000, { timeoutMs: 40_000 });
      // 매분 트리거라 앞 회차(노드가 4초 안쪽에 집어 건너뛴 회차)는 지우기 전에 정상으로 실행됐을 수 있다.
      // 지운 회차(oldFire)부터 실행이 없어야 한다
      const late = (await listExecutions(conn, { schedName: sched(), triggerGroup: 'd05' })).filter(
        (e) => (e.scheduledFireTime ?? e.fireTime) >= oldFire,
      );
      expect(late).toEqual([]);
      // 노드는 발화 시각에 상태가 ACQUIRED가 아니면 발화하지 않고 획득 기록을 지운다(releaseAcquiredTrigger)
      await waitFor(async () => (await firedRows(sched(), 'd05', 't')) === 0, {
        timeoutMs: 30_000,
        message: '노드가 획득 기록을 지움',
      }).catch(async (err: unknown) => {
        const fired = await conn.execute(
          `SELECT * FROM ${T('FIRED_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = 'd05'`,
          [sched()],
        );
        throw new Error(
          `${String(err)} 남은 행: ${JSON.stringify(fired.rows)} 옛 발화: ${oldFire} 지금: ${await dbNow()}`,
        );
      });
      expect(await triggerRows(sched(), 'd05', 't')).toBe(0);
    }, 180_000);

    it('D-06·DJ-02 실행 중인 잡의 트리거·잡을 지워도 실행은 오류 없이 끝나고 실행 기록이 지워진다 (통합)', async () => {
      // D-06: 실행 중인 트리거 삭제
      await node().addJob({
        name: 'job-d06',
        group: 'd06',
        type: 'NonConcurrentSleepJob',
        durable: true,
        data: { sleepSeconds: 8 },
      });
      await node().scheduleJob({
        trigger: { name: 'run', group: 'd06', forJob: { name: 'job-d06', group: 'd06' } },
      });
      await waitExecuting(sched(), 'd06', 'run');
      const d06 = await toolRun(sched(), delTrigger('d06', 'run'));
      expect(d06.warnings.map((w) => w.code)).toContain('DELETING_EXECUTING');
      await waitFor(async () => (await firedRows(sched(), 'd06', 'run')) === 0, {
        timeoutMs: 30_000,
        message: '실행 완료 뒤 실행 기록 삭제',
      });
      const runs = await listExecutions(conn, { schedName: sched(), triggerGroup: 'd06' });
      expect(runs.map((r) => r.outcome)).toEqual(['OK']);

      // DJ-02: 실행 중인 동시 실행 금지 잡(다른 트리거는 BLOCKED) 삭제
      await node().addJob({
        name: 'job-dj02',
        group: 'dj02',
        type: 'NonConcurrentSleepJob',
        durable: true,
        data: { sleepSeconds: 8 },
      });
      await node().scheduleJob({
        trigger: { name: 'run', group: 'dj02', forJob: { name: 'job-dj02', group: 'dj02' } },
      });
      await node().scheduleJob({
        trigger: {
          name: 'other',
          group: 'dj02',
          intervalMs: 60_000,
          startAt: Date.now() + 3_600_000,
          forJob: { name: 'job-dj02', group: 'dj02' },
        },
      });
      await waitExecuting(sched(), 'dj02', 'run');
      const job = { group: 'dj02', name: 'job-dj02' };
      const dj02 = await toolRun(sched(), { type: 'deleteJob', job });
      expect(dj02.warnings.map((w) => w.code)).toContain('DELETING_EXECUTING');
      expect(await jobRows(sched(), 'dj02', 'job-dj02')).toBe(0);
      await waitFor(async () => (await firedRows(sched(), 'dj02', 'run')) === 0, {
        timeoutMs: 30_000,
        message: '실행 완료 뒤 실행 기록 삭제',
      });
      const jobRuns = await listExecutions(conn, { schedName: sched(), triggerGroup: 'dj02' });
      expect(jobRuns.map((r) => r.outcome)).toEqual(['OK']);
    }, 180_000);
  });
});
