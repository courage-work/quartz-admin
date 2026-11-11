import type { MonitorData } from '@qa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TargetPoolManager,
  createDriverAdapters,
  collectMonitorData,
  evaluateRule,
  isTargetError,
  observeBlocked,
  queryDbNowMillis,
  stepAlert,
  triggerKeyOf,
  type AlertRuleSpec,
  type MonitorResult,
  type OpenAlertState,
  type PoolTarget,
  type SchedulerViewContext,
  type TargetConn,
  type TriggerObservation,
} from '../../src/index.js';
import {
  QUARTZ_VERSION,
  quartzTableName,
  startQuartzCluster,
  startTcpProxy,
  waitFor,
  type QuartzCluster,
  type TestbedNode,
  schedulerContext,
  TEST_DB_LABEL,
  type TestConnection,
} from '../support/index.js';

const T = (name: string) => quartzTableName(name as Parameters<typeof quartzTableName>[0]);
/**
 * 연체 기준(misfire 임계값 + 유예). 실제 기본값(2분)보다 짧게 둬 빨리 재현하되, 실제처럼 노드 비활성 판정
 * (테스트베드 체크인 2초 × 배수 3 = 6초)보다는 길게 둔다. 더 짧으면 클러스터가 내려갈 때 연체가 먼저 잡힌다
 */
const OVERDUE_AFTER_MS = 10_000;
const EXPECTED_NODES = 2;

type Rule = AlertRuleSpec & { key: string };
const SUPPRESSING = new Set(['CLUSTER_DOWN', 'MONITOR_UNREACHABLE']);
const SUPPRESSED = new Set(['OVERDUE', 'BLOCKED_LONG', 'NODE_MISSING']);

/**
 * 메모리에 상태를 두는 알림 엔진. apps/api의 `AlertEngine`과 같은 순서(억제 규칙 먼저, 억제 중이면 발송 안 함)로
 * `@qa/store`의 판정·수명주기 함수를 부른다. 발송 대신 `events`에 (규칙 타입:이벤트)를 남긴다.
 */
class MemoryEngine {
  readonly open = new Map<string, OpenAlertState>();
  readonly events: string[] = [];
  private observations: TriggerObservation[] = [];
  private failures = 0;

  constructor(private readonly rules: Rule[]) {}

  async round(collect: () => Promise<MonitorData>): Promise<void> {
    let result: MonitorResult;
    try {
      const data = await collect();
      this.failures = 0;
      this.observations = observeBlocked(this.observations, data.blockedTriggers, data.dbNow).next;
      result = { ok: true, data };
    } catch (err) {
      if (!isTargetError(err)) throw err;
      this.failures += 1;
      result = {
        ok: false,
        consecutiveFailures: this.failures,
        errorCode: err.code,
        errorMessage: err.message,
      };
    }
    const input = {
      result,
      expectedNodeCount: EXPECTED_NODES,
      blockedSince: new Map(this.observations.map((o) => [triggerKeyOf(o), o.firstSeenAt])),
      recentlyResumed: new Set<string>(),
    };
    const run = (rule: Rule, suppressed: boolean): boolean => {
      const existing = this.open.get(rule.key) ?? null;
      const step = stepAlert(existing, evaluateRule(rule, input), {
        now: Date.now(),
        renotifyMinutes: null,
        suppressed,
      });
      const notify = step.action === 'none' ? null : step.notify;
      if (notify) this.events.push(`${rule.type}:${notify}`);
      switch (step.action) {
        case 'none':
          return existing !== null;
        case 'open':
        case 'refresh':
          this.open.set(rule.key, {
            status: 'open',
            affected: step.affected,
            lastNotifiedAt: notify ? Date.now() : (existing?.lastNotifiedAt ?? null),
          });
          return true;
        case 'resolve':
          this.open.delete(rule.key);
          return false;
      }
    };
    let suppressing = false;
    for (const rule of this.rules.filter((r) => SUPPRESSING.has(r.type))) {
      if (run(rule, false)) suppressing = true;
    }
    for (const rule of this.rules.filter((r) => !SUPPRESSING.has(r.type))) {
      run(rule, suppressing && SUPPRESSED.has(rule.type));
    }
  }

  isOpen(key: string): boolean {
    return this.open.has(key);
  }
}

/**
 * 알림 규칙 엔진 (B-24, TRD §9.2, §9.3). 2노드 클러스터에서 각 규칙의 발생과 해소를 실제로 일으키고,
 * 감시 수집(`collectMonitorData`)과 판정(`evaluateRule`·`stepAlert`)이 맞게 잡는지 본다.
 * 트리거 단위 규칙은 케이스마다 그룹으로 범위를 좁혀 서로 섞이지 않게 한다.
 */
describe(`알림 규칙 엔진 (${TEST_DB_LABEL}, Quartz ${QUARTZ_VERSION})`, () => {
  let cluster: QuartzCluster;
  let conn: TestConnection;
  let pools: TargetPoolManager;
  let target: PoolTarget;
  let ctx: SchedulerViewContext;

  const sched = () => cluster.schedulerName;
  const node1 = (): TestbedNode => cluster.nodes.find((n) => n.instanceId === 'node-1')!;
  const run = <R>(fn: (c: TargetConn) => Promise<R>, t: PoolTarget = target) =>
    pools.withConnection(t, fn);
  const dbNow = () => run((c) => queryDbNowMillis(c, cluster.db.dialect));
  const collect =
    (t: PoolTarget = target) =>
    () =>
      run(
        (c) =>
          collectMonitorData(c, ctx, { checkinMultiplier: 3, overdueAfterMs: OVERDUE_AFTER_MS }),
        t,
      );

  async function stateOf(group: string, name: string): Promise<string | undefined> {
    const res = await conn.execute<[string]>(
      `SELECT TRIGGER_STATE FROM ${T('TRIGGERS')} WHERE SCHED_NAME = :1 AND TRIGGER_GROUP = :2 AND TRIGGER_NAME = :3`,
      [sched(), group, name],
    );
    return res.rows?.[0]?.[0];
  }

  /** 엔진을 한 회차씩 돌리며 조건을 기다린다 */
  const roundsUntil = (
    engine: MemoryEngine,
    done: () => boolean,
    message: string,
    source = collect(),
    timeoutMs = 60_000,
  ) =>
    waitFor(
      async () => {
        await engine.round(source);
        return done();
      },
      { timeoutMs, intervalMs: 1_000, message },
    );

  beforeAll(async () => {
    cluster = await startQuartzCluster({ nodes: 2 });
    conn = await cluster.db.connect();
    pools = new TargetPoolManager(createDriverAdapters());
    target = {
      id: 'alerts',
      info: cluster.db.targetInfo(),
    };
    ctx = schedulerContext(cluster.db, cluster.schedulerName);
  });

  afterAll(async () => {
    await pools?.closeAll();
    await conn?.close();
    await cluster?.stop();
  });

  it('TRIGGER_ERROR: 잡 클래스를 찾지 못해 ERROR가 된 트리거를 잡고, 고치면 해소한다', async () => {
    const engine = new MemoryEngine([
      { key: 'err', type: 'TRIGGER_ERROR', params: {}, scope: { kind: 'groups', groups: ['err'] } },
    ]);
    await node1().client.scheduleJob({
      job: { name: 'job', group: 'err', type: 'RecordingJob', durable: true },
      trigger: { name: 't', group: 'err', startAt: Date.now() + 3_600_000 },
    });
    await engine.round(collect());
    expect(engine.events).toEqual([]);

    // 노드가 잡 클래스를 읽지 못하면 triggerFired가 트리거를 ERROR로 둔다(JSS.triggerFired)
    const original = (
      await conn.execute<[string]>(
        `SELECT JOB_CLASS_NAME FROM ${T('JOB_DETAILS')} WHERE SCHED_NAME = :1 AND JOB_GROUP = 'err'`,
        [sched()],
      )
    ).rows![0]![0];
    await conn.execute(
      `UPDATE ${T('JOB_DETAILS')} SET JOB_CLASS_NAME = 'no.such.MissingJob' WHERE SCHED_NAME = :1 AND JOB_GROUP = 'err'`,
      [sched()],
    );
    await conn.execute(
      `UPDATE ${T('TRIGGERS')} SET NEXT_FIRE_TIME = :1 WHERE SCHED_NAME = :2 AND TRIGGER_GROUP = 'err'`,
      [await dbNow(), sched()],
    );
    await conn.commit();
    // 노드는 할 일이 없으면 idleWaitTime(30초)까지 잠들어 있다가 트리거를 집는다
    await waitFor(async () => (await stateOf('err', 't')) === 'ERROR', {
      message: 'ERROR 상태',
      timeoutMs: 60_000,
    });

    await engine.round(collect());
    expect(engine.events).toEqual(['TRIGGER_ERROR:fire']);
    expect(engine.open.get('err')?.affected).toEqual({
      kind: 'triggers',
      total: 1,
      triggers: [{ group: 'err', name: 't' }],
    });

    // 운영자가 클래스를 고치고 트리거를 되돌린다
    await conn.execute(
      `UPDATE ${T('JOB_DETAILS')} SET JOB_CLASS_NAME = :1 WHERE SCHED_NAME = :2 AND JOB_GROUP = 'err'`,
      [original, sched()],
    );
    await conn.execute(
      `UPDATE ${T('TRIGGERS')} SET TRIGGER_STATE = 'WAITING', NEXT_FIRE_TIME = :1 WHERE SCHED_NAME = :2 AND TRIGGER_GROUP = 'err'`,
      [(await dbNow()) + 3_600_000, sched()],
    );
    await conn.commit();
    await engine.round(collect());
    expect(engine.events).toEqual(['TRIGGER_ERROR:fire', 'TRIGGER_ERROR:resolve']);
  });

  it('BLOCKED_LONG: 동시 실행 금지 잡이 오래 돌아 BLOCKED가 이어지면 알리고, 끝나면 해소한다', async () => {
    // 실제 기본값은 30분. 3초로 줄여 재현한다
    const engine = new MemoryEngine([
      {
        key: 'blocked',
        type: 'BLOCKED_LONG',
        params: { minutes: 0.05 },
        scope: { kind: 'groups', groups: ['blk'] },
      },
    ]);
    await node1().client.addJob({
      name: 'job',
      group: 'blk',
      type: 'NonConcurrentSleepJob',
      durable: true,
      data: { sleepSeconds: 15 },
    });
    // 'later'는 실행 중인 동안 BLOCKED로 기다린다
    await node1().client.scheduleJob({
      trigger: {
        name: 'later',
        group: 'blk',
        forJob: { name: 'job', group: 'blk' },
        startAt: Date.now() + 3_600_000,
      },
    });
    await node1().client.scheduleJob({
      trigger: { name: 'now', group: 'blk', forJob: { name: 'job', group: 'blk' } },
    });
    await waitFor(async () => (await stateOf('blk', 'later')) === 'BLOCKED', {
      message: 'BLOCKED 상태',
    });

    await engine.round(collect());
    expect(engine.events).toEqual([]);
    await roundsUntil(engine, () => engine.isOpen('blocked'), 'BLOCKED_LONG 발생');
    expect(engine.events).toEqual(['BLOCKED_LONG:fire']);
    expect(engine.open.get('blocked')?.affected).toMatchObject({
      triggers: [{ group: 'blk', name: 'later', state: 'BLOCKED' }],
    });

    await roundsUntil(
      engine,
      () => !engine.isOpen('blocked'),
      'BLOCKED_LONG 해소',
      collect(),
      30_000,
    );
    expect(engine.events).toEqual(['BLOCKED_LONG:fire', 'BLOCKED_LONG:resolve']);
    expect(await stateOf('blk', 'later')).toBe('WAITING');
  });

  it('NODE_MISSING: 노드 하나를 멈추면 알리고, 다시 띄우면 해소한다', async () => {
    const engine = new MemoryEngine([
      { key: 'node', type: 'NODE_MISSING', params: {}, scope: { kind: 'all' } },
      { key: 'down', type: 'CLUSTER_DOWN', params: {}, scope: { kind: 'all' } },
    ]);
    await engine.round(collect());
    expect(engine.events).toEqual([]);

    await cluster.nodes.find((n) => n.instanceId === 'node-2')!.stop();
    cluster.nodes.splice(
      cluster.nodes.findIndex((n) => n.instanceId === 'node-2'),
      1,
    );
    await roundsUntil(engine, () => engine.isOpen('node'), 'NODE_MISSING 발생');
    expect(engine.events).toEqual(['NODE_MISSING:fire']);
    expect(engine.open.get('node')?.affected).toMatchObject({
      kind: 'nodes',
      active: 1,
      expected: 2,
    });

    await cluster.addNode('node-2');
    await roundsUntil(engine, () => !engine.isOpen('node'), 'NODE_MISSING 해소');
    expect(engine.events).toEqual(['NODE_MISSING:fire', 'NODE_MISSING:resolve']);
  });

  it('노드가 모두 멈추면 CLUSTER_DOWN만 보내고 OVERDUE·NODE_MISSING은 억제한다. 복구하면 모두 해소된다', async () => {
    const engine = new MemoryEngine([
      { key: 'overdue', type: 'OVERDUE', params: {}, scope: { kind: 'groups', groups: ['od'] } },
      { key: 'node', type: 'NODE_MISSING', params: {}, scope: { kind: 'all' } },
      { key: 'down', type: 'CLUSTER_DOWN', params: {}, scope: { kind: 'all' } },
    ]);
    await node1().client.scheduleJob({
      job: { name: 'job', group: 'od', type: 'RecordingJob', durable: true },
      trigger: { name: 'every-second', group: 'od', intervalMs: 1_000 },
    });
    await engine.round(collect());
    expect(engine.events).toEqual([]);

    await Promise.all(cluster.nodes.map((n) => n.stop()));
    cluster.nodes.length = 0;
    // 노드의 마지막 체크인은 몇 초씩 다르다. 그 사이 회차에는 노드 하나만 빠진 것으로 보여 NODE_MISSING이
    // 먼저 나갈 수 있다(실제로도 그렇다, TRD §9.3). 두 노드가 모두 비활성이 된 뒤부터 회차를 돌린다
    await waitFor(async () => (await collect()()).nodes.every((n) => !n.active), {
      message: '두 노드 모두 비활성',
    });
    await roundsUntil(
      engine,
      () => engine.isOpen('down') && engine.isOpen('overdue') && engine.isOpen('node'),
      'CLUSTER_DOWN·OVERDUE 발생',
    );
    // 연체는 열려 있지만 보내지 않았다
    expect(engine.events).toEqual(['CLUSTER_DOWN:fire']);
    expect(engine.open.get('overdue')).toMatchObject({
      lastNotifiedAt: null,
      affected: { triggers: [{ group: 'od', name: 'every-second' }] },
    });

    await Promise.all([cluster.addNode('node-1'), cluster.addNode('node-2')]);
    await roundsUntil(
      engine,
      () => !engine.isOpen('down') && !engine.isOpen('overdue') && !engine.isOpen('node'),
      '복구 뒤 모두 해소',
      collect(),
      90_000,
    );
    expect(engine.events[0]).toBe('CLUSTER_DOWN:fire');
    expect(engine.events).toContain('CLUSTER_DOWN:resolve');
    // 억제가 풀리기 전에는 OVERDUE를 보내지 않았다
    const downResolved = engine.events.indexOf('CLUSTER_DOWN:resolve');
    expect(
      engine.events.slice(0, downResolved).filter((e) => !e.startsWith('CLUSTER_DOWN')),
    ).toEqual([]);
  }, 180_000);

  it('MONITOR_UNREACHABLE: 대상 DB에 연속으로 연결하지 못하면 알리고, 연결되면 해소한다', async () => {
    const engine = new MemoryEngine([
      {
        key: 'unreachable',
        type: 'MONITOR_UNREACHABLE',
        params: { failures: 2 },
        scope: { kind: 'all' },
      },
    ]);
    const proxy = await startTcpProxy(target.info.host, target.info.port);
    const proxied: PoolTarget = {
      id: 'alerts-proxied',
      info: { ...target.info, host: proxy.host, port: proxy.port },
    };
    await engine.round(collect(proxied));
    await proxy.close();
    await engine.round(collect(proxied));
    expect(engine.isOpen('unreachable')).toBe(false);
    await engine.round(collect(proxied));
    expect(engine.events).toEqual(['MONITOR_UNREACHABLE:fire']);
    expect(engine.open.get('unreachable')?.affected).toMatchObject({
      kind: 'monitor',
      failures: 2,
    });

    // 접속 정보를 고쳐(프록시 없이) 다시 연결된다
    await engine.round(collect());
    expect(engine.events).toEqual(['MONITOR_UNREACHABLE:fire', 'MONITOR_UNREACHABLE:resolve']);
  });
});
