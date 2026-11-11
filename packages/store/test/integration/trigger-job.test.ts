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
  type QuartzCluster,
  type RowSnapshot,
  type TestbedNode,
  TEST_DB_LABEL,
  schedulerContext,
  triggerAccessIsFree,
  type TestConnection,
} from '../support/index.js';

/** 차등 테스트의 두 기준 인스턴스. 같은 초기 상태를 만들고 한쪽은 Quartz API, 다른 쪽은 도구로 명령한다 */
const REF_QUARTZ = 'TriggerQuartz';
const REF_TOOL = 'TriggerTool';
const T = (name: string) => quartzTableName(name as Parameters<typeof quartzTableName>[0]);
const ACTOR = 'tester';

/** 즉시 실행 트리거의 차등 비교에서 빼는 컬럼 (TRD §7.5): 이름, 시각, DESCRIPTION */
const VOLATILE = ['TRIGGER_NAME', 'START_TIME', 'NEXT_FIRE_TIME', 'DESCRIPTION'];

/** 행 스냅샷에서 이름·시각·DESCRIPTION을 빼고 다시 정렬한다 */
function normalize(snapshot: RowSnapshot): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(snapshot).map(([table, rows]) => [
      table,
      (rows as Record<string, unknown>[])
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(Object.entries(row).filter(([col]) => !VOLATILE.includes(col))),
          ),
        )
        .sort(),
    ]),
  );
}

/**
 * 즉시 실행 (B-19, TRD §7.5, 부록 A.5 T-01~T-09).
 * 2노드 클러스터와 `start()`하지 않는 기준 인스턴스 두 개를 같은 DB 스키마에 띄운다.
 */
describe(`즉시 실행 (${TEST_DB_LABEL}, Quartz ${QUARTZ_VERSION})`, () => {
  let cluster: QuartzCluster;
  let refQuartz: TestbedNode;
  let refTool: TestbedNode;
  let conn: TestConnection;
  let pools: TargetPoolManager;
  let target: PoolTarget;

  const ctxFor = (schedName: string): SchedulerCommandContext =>
    schedulerContext(cluster.db, schedName);

  const run = <R>(fn: (c: TargetConn) => Promise<R>) => pools.withConnection(target, fn);

  /** 화면처럼 미리보기의 기대 상태를 붙여 실행한다 */
  const toolRun = (
    schedName: string,
    command: QuartzCommand,
    expected?: CommandExpected,
  ): Promise<CommandOutcome> =>
    run(async (c) => {
      const ctx = ctxFor(schedName);
      const preview = await previewCommand(c, ctx, command, { actor: ACTOR });
      return executeCommand(c, ctx, command, expected ?? expectedOf(preview.subject), {
        actor: ACTOR,
      });
    });

  const triggerJob = (group: string, name: string): QuartzCommand => ({
    type: 'triggerJob',
    job: { group, name },
  });

  async function lockIsFree(schedName: string): Promise<boolean> {
    return triggerAccessIsFree(conn, cluster.db, schedName, T('LOCKS'));
  }

  /** 잡의 즉시 실행 트리거(`DEFAULT` 그룹, `MT_`) 행 */
  async function insertedRows(schedName: string, jobGroup: string, jobName: string) {
    const res = await conn.execute<[string, string, string | null]>(
      `SELECT TRIGGER_NAME, TRIGGER_STATE, DESCRIPTION FROM ${T('TRIGGERS')} ` +
        `WHERE SCHED_NAME = :1 AND JOB_GROUP = :2 AND JOB_NAME = :3 AND TRIGGER_GROUP = 'DEFAULT'`,
      [schedName, jobGroup, jobName],
    );
    return (res.rows ?? []).map(([name, state, description]) => ({ name, state, description }));
  }

  async function count(sql: string, binds: unknown[]): Promise<number> {
    const res = await conn.execute<[number]>(sql, binds);
    return res.rows?.[0]?.[0] ?? 0;
  }

  beforeAll(async () => {
    cluster = await startQuartzCluster({ nodes: 2 });
    [refQuartz, refTool] = await Promise.all([
      cluster.addReference(REF_QUARTZ),
      cluster.addReference(REF_TOOL),
    ]);
    conn = await cluster.db.connect();
    pools = new TargetPoolManager(createDriverAdapters());
    target = {
      id: 'trigger-job',
      info: cluster.db.targetInfo(),
    };
  });

  afterAll(async () => {
    await pools?.closeAll();
    await conn?.close();
    await cluster?.stop();
  });

  // ── 차등 (부록 A.5 T-01~T-06) ────────────────────────────

  /** 두 기준 인스턴스에 같은 잡(`job-<group>`)을 만든다 */
  async function seedBoth(group: string, nonConcurrent = false): Promise<void> {
    for (const ref of [refQuartz, refTool]) {
      await ref.client.addJob({
        name: `job-${group}`,
        group,
        type: nonConcurrent ? 'NonConcurrentSleepJob' : 'RecordingJob',
        durable: true,
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

  const pausedGroupRow = (group: string) =>
    `INSERT INTO ${T('PAUSED_TRIGGER_GRPS')} (SCHED_NAME, TRIGGER_GROUP) VALUES (:sched, '${group}')`;
  const clearPausedGroups = `DELETE FROM ${T('PAUSED_TRIGGER_GRPS')} WHERE SCHED_NAME = :sched`;

  const executingRow = (group: string, nonConcurrent: boolean) =>
    `INSERT INTO ${T('FIRED_TRIGGERS')} (SCHED_NAME, ENTRY_ID, TRIGGER_NAME, TRIGGER_GROUP, INSTANCE_NAME, ` +
    `FIRED_TIME, SCHED_TIME, PRIORITY, STATE, JOB_NAME, JOB_GROUP, IS_NONCONCURRENT, REQUESTS_RECOVERY) ` +
    `VALUES (:sched, '${group}-exe', 'other', '${group}', 'node-x', 1000, 1000, 5, 'EXECUTING', ` +
    `'job-${group}', '${group}', '${nonConcurrent ? '1' : '0'}', '0')`;

  /** Quartz `triggerJob`과 도구 결과의 행 스냅샷이 이름·시각·DESCRIPTION을 빼고 같은지 비교한다 */
  async function differential(group: string): Promise<CommandOutcome> {
    await refQuartz.client.triggerJob({ group, name: `job-${group}` });
    const out = await toolRun(REF_TOOL, triggerJob(group, `job-${group}`));
    const [q, t] = await Promise.all([
      refQuartz.client.snapshot(REF_QUARTZ),
      refQuartz.client.snapshot(REF_TOOL),
    ]);
    expect(normalize(t)).toEqual(normalize(q));
    expect(await lockIsFree(REF_TOOL)).toBe(true);

    const [inserted] = await insertedRows(REF_TOOL, group, `job-${group}`);
    expect(inserted?.name).toMatch(/^MT_[0-9a-z]+$/);
    expect(inserted?.description).toBe(`quartz-admin: ${ACTOR}`);
    expect(out.inserts.map((i) => i.name)).toEqual([inserted?.name]);
    return out;
  }

  it('T-01 일시정지 없음: DEFAULT 그룹 SIMPLE 트리거, 상태 WAITING (차등)', async () => {
    await seedBoth('t01');
    const out = await differential('t01');
    expect(out.inserts[0]).toMatchObject({ group: 'DEFAULT', state: 'WAITING' });
    const res = await conn.execute<[number, number, number, number, number]>(
      `SELECT t.PREV_FIRE_TIME, t.END_TIME, t.PRIORITY, t.MISFIRE_INSTR, s.REPEAT_COUNT ` +
        `FROM ${T('TRIGGERS')} t JOIN ${T('SIMPLE_TRIGGERS')} s ON s.SCHED_NAME = t.SCHED_NAME ` +
        `AND s.TRIGGER_GROUP = t.TRIGGER_GROUP AND s.TRIGGER_NAME = t.TRIGGER_NAME ` +
        `WHERE t.SCHED_NAME = :1 AND t.TRIGGER_NAME = :2`,
      [REF_TOOL, out.inserts[0]!.name],
    );
    expect(res.rows?.[0]).toEqual([-1, 0, 5, 0, 0]);
  });

  it('T-02 DEFAULT 그룹이 일시정지면 PAUSED, 그룹 행은 그대로 (차등)', async () => {
    await seedBoth('t02');
    await fixtureBoth([pausedGroupRow('DEFAULT')]);
    try {
      const out = await differential('t02');
      expect(out.inserts[0]?.state).toBe('PAUSED');
      expect(out.groupChanges).toEqual([]);
    } finally {
      await fixtureBoth([clearPausedGroups]);
    }
  });

  it('T-03 전체 일시정지만 있으면 DEFAULT 그룹 행을 넣고 PAUSED (차등)', async () => {
    await seedBoth('t03');
    await fixtureBoth([pausedGroupRow(ALL_GROUPS_PAUSED)]);
    try {
      const out = await differential('t03');
      expect(out.inserts[0]?.state).toBe('PAUSED');
      expect(out.groupChanges).toEqual([{ group: 'DEFAULT', paused: true }]);
    } finally {
      await fixtureBoth([clearPausedGroups]);
    }
  });

  it('T-04·T-05 동시 실행 금지 잡이 실행 중이면 BLOCKED, DEFAULT 그룹 일시정지까지면 PAUSED_BLOCKED (차등)', async () => {
    await seedBoth('t04', true);
    await fixtureBoth([executingRow('t04', true)]);
    const blocked = await differential('t04');
    expect(blocked.inserts[0]?.state).toBe('BLOCKED');
    expect(blocked.warnings.map((w) => w.code)).toContain('JOB_RUNNING_NONCONCURRENT');

    await seedBoth('t05', true);
    await fixtureBoth([executingRow('t05', true), pausedGroupRow('DEFAULT')]);
    try {
      const both = await differential('t05');
      expect(both.inserts[0]?.state).toBe('PAUSED_BLOCKED');
    } finally {
      await fixtureBoth([clearPausedGroups]);
    }
  });

  it('T-06 동시 실행 허용 잡은 실행 중이어도 WAITING (차등)', async () => {
    await seedBoth('t06');
    await fixtureBoth([executingRow('t06', false)]);
    const out = await differential('t06');
    expect(out.inserts[0]?.state).toBe('WAITING');
  });

  it('T-07 없는 잡은 NOT_FOUND이고 행은 그대로 (도구)', async () => {
    const before = await refTool.client.snapshot(REF_TOOL);
    const err = await toolRun(REF_TOOL, triggerJob('t07', 'missing'), {
      triggers: [],
      pausedGroups: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandRejection);
    expect(err).toMatchObject({ code: 'NOT_FOUND' });
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(before);
    expect(await lockIsFree(REF_TOOL)).toBe(true);
  });

  // ── 실제 클러스터 (부록 A.5 T-08, T-09) ─────────────────────

  describe('2노드 클러스터', () => {
    const sched = () => cluster.schedulerName;

    it('T-08 정확히 한 번 실행되고, 끝나면 새 트리거의 TRIGGERS·SIMPLE_TRIGGERS·FIRED_TRIGGERS 행이 사라진다 (통합)', async () => {
      await cluster.nodes[0]!.client.addJob({
        name: 'job-t08',
        group: 't08',
        type: 'RecordingJob',
        durable: true,
      });
      const out = await toolRun(sched(), triggerJob('t08', 'job-t08'));
      const name = out.inserts[0]!.name!;
      expect(out.warnings).toEqual([]);

      const gone = async () =>
        (await count(
          `SELECT COUNT(*) FROM ${T('TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_NAME = :2`,
          [sched(), name],
        )) +
          (await count(
            `SELECT COUNT(*) FROM ${T('SIMPLE_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_NAME = :2`,
            [sched(), name],
          )) +
          (await count(
            `SELECT COUNT(*) FROM ${T('FIRED_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_NAME = :2`,
            [sched(), name],
          )) ===
        0;
      await waitFor(gone, { timeoutMs: 30_000, message: '실행 후 트리거 삭제' });
      // 두 노드가 모두 돌고 있어도 한 번만 실행된다. 늦게 집는 노드가 없는지 조금 더 본다
      await sleep(3_000);
      const runs = await listExecutions(conn, { schedName: sched(), triggerName: name });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ jobName: 'job-t08', jobGroup: 't08' });
    }, 60_000);

    it('T-09 실행 도중 실행 노드가 죽으면 살아남은 노드가 복구하며 새 트리거(COMPLETE)를 지운다 (통합)', async () => {
      await cluster.nodes[0]!.client.addJob({
        name: 'job-t09',
        group: 't09',
        type: 'LongJob',
        durable: true,
        data: { durationSeconds: 120 },
      });
      const out = await toolRun(sched(), triggerJob('t09', 'job-t09'));
      const name = out.inserts[0]!.name!;

      // 실행 중인 노드를 찾는다
      let instance = '';
      await waitFor(
        async () => {
          const res = await conn.execute<[string, string]>(
            `SELECT INSTANCE_NAME, STATE FROM ${T('FIRED_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_NAME = :2`,
            [sched(), name],
          );
          const row = res.rows?.[0];
          if (row?.[1] !== 'EXECUTING') return false;
          instance = row[0];
          return true;
        },
        { timeoutMs: 30_000, message: '실행 시작' },
      );
      expect((await insertedRows(sched(), 't09', 'job-t09'))[0]?.state).toBe('COMPLETE');

      const victim = cluster.nodes.find((n) => n.instanceId === instance);
      expect(victim, `실행 노드 ${instance}`).toBeDefined();
      // 프로세스가 죽은 것처럼 기다리지 않고 멈춘다
      await victim!.container.stop({ timeout: 0 });

      await waitFor(
        async () =>
          (await count(
            `SELECT COUNT(*) FROM ${T('TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_NAME = :2`,
            [sched(), name],
          )) === 0,
        { timeoutMs: 90_000, message: '살아남은 노드의 복구' },
      );
      expect(
        await count(
          `SELECT COUNT(*) FROM ${T('FIRED_TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_NAME = :2`,
          [sched(), name],
        ),
      ).toBe(0);
    }, 150_000);
  });
});
