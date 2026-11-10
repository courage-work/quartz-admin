import type { CommandExpected, QuartzCommand } from '@qa/shared';
import type oracledb from 'oracledb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandRejection,
  OracleAdapter,
  QUARTZ_REQUIRED_TABLES,
  TargetPoolManager,
  acquireTriggerAccess,
  createTableSet,
  executeCommand,
  expectedOf,
  oracleDialect,
  previewCommand,
  queryDbNowMillis,
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
  startTcpProxy,
  waitFor,
  waitForExecutions,
  type OracleQuartzCluster,
  type TestbedNode,
} from '../support/index.js';

/** 차등 테스트의 두 기준 인스턴스. 같은 초기 상태를 만들고 한쪽은 Quartz API, 다른 쪽은 도구로 명령한다 */
const REF_QUARTZ = 'DiffQuartz';
const REF_TOOL = 'DiffTool';
const T = (name: string) => quartzTableName(name as Parameters<typeof quartzTableName>[0]);

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
 * 제어 명령 프레임워크 (B-17, TRD §7.1~7.3, 부록 A.2 P-01~P-04, A.8 X-01~X-04).
 * 일시정지와 재개의 나머지 케이스(B-18)는 `pause-resume.test.ts`에 있다.
 * 2노드 클러스터와 `start()`하지 않는 기준 인스턴스 두 개를 같은 Oracle 스키마에 띄운다.
 */
describe(`제어 명령 (Oracle Free 23, Quartz ${QUARTZ_VERSION})`, () => {
  let cluster: OracleQuartzCluster;
  let refQuartz: TestbedNode;
  let refTool: TestbedNode;
  let node1: TestbedNode;
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

  /** 화면처럼 미리보기의 기대 상태를 붙여 실행한다 */
  const toolRun = (schedName: string, command: QuartzCommand, expected?: CommandExpected) =>
    run(async (c) => {
      const ctx = ctxFor(schedName);
      const preview = await previewCommand(c, ctx, command);
      return executeCommand(c, ctx, command, expected ?? expectedOf(preview.subject));
    });

  /** TRIGGER_ACCESS가 풀려 있는지(부록 A.1 공통 사후 조건). 클러스터 노드가 잠깐씩 잡으므로 3초까지 기다린다 */
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

  async function state(schedName: string, group: string, name: string): Promise<string | null> {
    const res = await conn.execute<[string]>(
      `SELECT TRIGGER_STATE FROM ${T('TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = :2 AND TRIGGER_NAME = :3`,
      [schedName, group, name],
    );
    return res.rows?.[0]?.[0] ?? null;
  }

  beforeAll(async () => {
    cluster = await startOracleQuartzCluster({ nodes: 2 });
    [refQuartz, refTool] = await Promise.all([
      cluster.addReference(REF_QUARTZ),
      cluster.addReference(REF_TOOL),
    ]);
    node1 = cluster.nodes[0]!;
    conn = await cluster.oracle.connect();
    pools = new TargetPoolManager([new OracleAdapter()]);
    target = {
      id: 'commands',
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

  // ── 차등: pauseTrigger (부록 A.2) ─────────────────────────────

  /** 두 기준 인스턴스에 같은 잡과 트리거를 만든다. 시작 시각을 고정해 NEXT_FIRE_TIME까지 같게 한다 */
  async function seedBoth(group: string, nonConcurrent = false): Promise<void> {
    const startAt = Date.now() + 3_600_000;
    for (const ref of [refQuartz, refTool]) {
      await ref.client.scheduleJob({
        job: {
          name: `job-${group}`,
          group,
          type: nonConcurrent ? 'NonConcurrentSleepJob' : 'RecordingJob',
          durable: true,
        },
        trigger: { name: 't', group, startAt, intervalMs: 60_000, repeatCount: -1 },
      });
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

  const setState = (group: string, value: string) =>
    `UPDATE ${T('TRIGGERS')} SET TRIGGER_STATE = '${value}' WHERE SCHED_NAME = :sched AND TRIGGER_GROUP = '${group}'`;

  const firedRow = (group: string, entry: string, st: string, executing: boolean) =>
    `INSERT INTO ${T('FIRED_TRIGGERS')} (SCHED_NAME, ENTRY_ID, TRIGGER_NAME, TRIGGER_GROUP, INSTANCE_NAME, ` +
    `FIRED_TIME, SCHED_TIME, PRIORITY, STATE, JOB_NAME, JOB_GROUP, IS_NONCONCURRENT, REQUESTS_RECOVERY) ` +
    `VALUES (:sched, '${entry}', 't', '${group}', 'node-x', 1000, 1000, 5, '${st}', ` +
    (executing ? `'job-${group}', '${group}', '1'` : `NULL, NULL, '0'`) +
    `, '0')`;

  /** Quartz `pauseTrigger`와 도구 결과의 행 스냅샷이 같은지 비교한다 */
  async function differential(group: string) {
    const key = { group, name: 't' };
    await refQuartz.client.pauseTrigger(key);
    const out = await toolRun(REF_TOOL, { type: 'pauseTrigger', trigger: key });
    const [quartz, tool] = await Promise.all([
      refQuartz.client.snapshot(REF_QUARTZ),
      refQuartz.client.snapshot(REF_TOOL),
    ]);
    expect(tool).toEqual(quartz);
    expect(await lockIsFree(REF_TOOL)).toBe(true);
    return out;
  }

  it('P-01 WAITING → PAUSED, NEXT_FIRE_TIME과 PAUSED_TRIGGER_GRPS는 그대로 (차등)', async () => {
    await seedBoth('p01');
    const out = await differential('p01');
    expect(out.changes).toEqual([{ group: 'p01', name: 't', from: 'WAITING', to: 'PAUSED' }]);
    expect(await state(REF_TOOL, 'p01', 't')).toBe('PAUSED');
  });

  it('P-02 ACQUIRED → PAUSED, 획득 기록(FIRED_TRIGGERS)은 그대로 (차등)', async () => {
    await seedBoth('p02');
    await fixtureBoth([setState('p02', 'ACQUIRED'), firedRow('p02', 'p02-acq', 'ACQUIRED', false)]);
    const out = await differential('p02');
    expect(out.changes[0]).toMatchObject({ from: 'ACQUIRED', to: 'PAUSED' });
  });

  it('P-03 동시 실행 금지 잡 실행 중의 BLOCKED → PAUSED_BLOCKED (차등)', async () => {
    await seedBoth('p03', true);
    await fixtureBoth([setState('p03', 'BLOCKED'), firedRow('p03', 'p03-exe', 'EXECUTING', true)]);
    const out = await differential('p03');
    expect(out.changes[0]).toMatchObject({ from: 'BLOCKED', to: 'PAUSED_BLOCKED' });
  });

  it('P-04 PAUSED, PAUSED_BLOCKED, ERROR, COMPLETE는 바꾸지 않고 "변경 없음"으로 응답한다 (차등)', async () => {
    for (const st of ['PAUSED', 'PAUSED_BLOCKED', 'ERROR', 'COMPLETE']) {
      const group = `p04-${st.toLowerCase()}`;
      await seedBoth(group);
      await fixtureBoth([setState(group, st)]);
      const out = await differential(group);
      expect(out.changes).toEqual([]);
      expect(out.warnings.map((w) => w.code)).toEqual(['NO_CHANGE']);
      expect(await state(REF_TOOL, group, 't')).toBe(st);
    }
  });

  // ── 잠금과 경합 (부록 A.8) ─────────────────────────────────

  it('X-01 잠금을 다른 쪽이 쥐고 있으면 약 5초 뒤 LOCK_TIMEOUT, 행은 그대로', async () => {
    await seedBoth('x01');
    const before = await refTool.client.snapshot(REF_TOOL);
    await refTool.client.holdLock({ seconds: 10, schedName: REF_TOOL });

    const started = Date.now();
    const err: unknown = await toolRun(REF_TOOL, {
      type: 'pauseTrigger',
      trigger: { group: 'x01', name: 't' },
    }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toMatchObject({ name: 'TargetError', code: 'LOCK_TIMEOUT' });
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(9_000);
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(before);
    // 테스트베드가 10초 뒤 놓으면 다시 잡을 수 있다
    await waitFor(() => lockIsFree(REF_TOOL), { timeoutMs: 15_000, message: '잠금 해제' });
  }, 60_000);

  it('X-04 화면에서 본 상태(WAITING)와 실제(PAUSED)가 다르면 STATE_CONFLICT와 최신 상태, 행은 그대로', async () => {
    await refTool.client.scheduleJob({
      job: { name: 'job-x04', group: 'x04', type: 'RecordingJob', durable: true },
      trigger: { name: 't', group: 'x04', startAt: Date.now() + 3_600_000, intervalMs: 60_000 },
    });
    await refTool.client.pauseTrigger({ group: 'x04', name: 't' });
    const before = await refTool.client.snapshot(REF_TOOL);

    const err: unknown = await toolRun(
      REF_TOOL,
      { type: 'pauseTrigger', trigger: { group: 'x04', name: 't' } },
      { triggers: [{ group: 'x04', name: 't', state: 'WAITING' }], pausedGroups: [] },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CommandRejection);
    expect(err).toMatchObject({
      code: 'STATE_CONFLICT',
      current: { triggers: [{ group: 'x04', name: 't', state: 'PAUSED' }], pausedGroups: [] },
    });
    expect(await refTool.client.snapshot(REF_TOOL)).toEqual(before);
    expect(await lockIsFree(REF_TOOL)).toBe(true);
  });

  // ── 실제 클러스터 (부록 A.8 통합) ─────────────────────────

  describe('2노드 클러스터', () => {
    const sched = () => cluster.schedulerName;

    beforeAll(async () => {
      // 계속 발화하는 트리거. 명령 뒤에도 노드가 정상 동작하는지 이 트리거의 실행 기록으로 본다
      await node1.client.scheduleJob({
        job: { name: 'heartbeat', group: 'live', type: 'RecordingJob', durable: true },
        trigger: { name: 'beat', group: 'live', intervalMs: 1_000 },
      });
      await waitForExecutions(conn, { schedName: sched(), triggerName: 'beat' }, { min: 2 });
    });

    /** `after` 이후 heartbeat가 `min`번 더 발화하는지 */
    const keepsFiring = (after: number, min = 2) =>
      waitFor(
        async () => {
          const rows = await listExecutions(conn, { schedName: sched(), triggerName: 'beat' });
          return rows.filter((r) => r.fireTime > after).length >= min;
        },
        { timeoutMs: 20_000, message: '클러스터 발화 계속' },
      );

    it('X-02 잠금 행이 없어도 도구가 넣고 성공한다. 일시정지한 트리거는 그 뒤로 발화하지 않는다', async () => {
      await node1.client.scheduleJob({
        job: { name: 'victim', group: 'live', type: 'RecordingJob', durable: true },
        trigger: { name: 'victim', group: 'live', intervalMs: 1_000 },
      });
      await waitForExecutions(conn, { schedName: sched(), triggerName: 'victim' });

      await node1.client.fixtureSql([
        `DELETE FROM ${T('LOCKS')} WHERE SCHED_NAME = '${sched()}' AND LOCK_NAME = 'TRIGGER_ACCESS'`,
      ]);
      const out = await toolRun(sched(), {
        type: 'pauseTrigger',
        trigger: { group: 'live', name: 'victim' },
      });
      // 잠금을 잡은 뒤 읽은 DB 시각. 이 뒤로는 커밋 전까지 노드가 발화할 수 없고(triggersFired는 잠금 안),
      // 커밋 뒤에는 PAUSED라 발화하지 않는다. 노드와 DB는 같은 Docker VM 시계를 쓰므로 호스트 시계 대신 이 값과 비교한다
      const lockedAt = out.dbNow;

      // 노드가 먼저 다시 넣었으면 'locked'다. 어느 쪽이든 성공해야 한다
      expect(['inserted', 'locked']).toContain(out.lock);
      expect(out.after.triggers[0]?.state).toBe('PAUSED');
      expect((await node1.client.snapshot()).LOCKS).toContainEqual({ LOCK_NAME: 'TRIGGER_ACCESS' });
      await keepsFiring(lockedAt);
      await sleep(2_000);
      const late = (
        await listExecutions(conn, { schedName: sched(), triggerName: 'victim' })
      ).filter((r) => r.fireTime > lockedAt);
      expect(late).toEqual([]);
      expect(await lockIsFree(sched())).toBe(true);
    }, 90_000);

    it('X-03 잠금을 잡은 도구 커넥션이 트랜잭션 도중 끊기면 DB가 되돌리고 노드는 계속 발화한다', async () => {
      await node1.client.scheduleJob({
        job: { name: 'survivor', group: 'live', type: 'RecordingJob', durable: true },
        trigger: { name: 'survivor', group: 'live', startAt: Date.now() + 3_600_000 },
      });
      const proxy = await startTcpProxy(target.info.host, target.info.port);
      const proxied: PoolTarget = {
        id: 'proxied',
        info: { ...target.info, host: proxy.host, port: proxy.port },
      };
      const ctx = ctxFor(sched());

      let cutAt = 0;
      await pools
        .withConnection(proxied, async (c) => {
          await acquireTriggerAccess(c, ctx);
          await c.execute(
            `UPDATE ${T('TRIGGERS')} SET TRIGGER_STATE = 'PAUSED' WHERE SCHED_NAME = :p1 AND TRIGGER_NAME = 'survivor'`,
            [sched()],
          );
          // 프로세스가 죽은 것과 같이 소켓을 끊는다. 커밋은 하지 않았다
          cutAt = await queryDbNowMillis(c, oracleDialect);
          await proxy.close();
        })
        .catch(() => undefined);

      await waitFor(() => lockIsFree(sched()), { timeoutMs: 30_000, message: '잠금 해제' });
      expect(await state(sched(), 'live', 'survivor')).toBe('WAITING');
      await keepsFiring(cutAt);
      await pools.invalidate('proxied');
    }, 90_000);
  });
});
