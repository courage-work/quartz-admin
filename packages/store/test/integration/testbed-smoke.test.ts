import type oracledb from 'oracledb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  QUARTZ_TABLES,
  QUARTZ_VERSION,
  checkedInInstances,
  initQuartzSchema,
  listExecutions,
  quartzCatalogName,
  quartzTableName,
  sleep,
  startOracleQuartzCluster,
  waitFor,
  waitForExecutions,
  type OracleQuartzCluster,
  type TestbedNode,
} from '../support/index.js';

describe(`quartz-testbed 2노드 클러스터 (Oracle Free 23, Quartz ${QUARTZ_VERSION})`, () => {
  let cluster: OracleQuartzCluster;
  let conn: oracledb.Connection;
  let node1: TestbedNode;
  let node2: TestbedNode;

  beforeAll(async () => {
    cluster = await startOracleQuartzCluster({ nodes: 2 });
    conn = await cluster.oracle.connect();
    [node1, node2] = cluster.nodes as [TestbedNode, TestbedNode];
  });

  afterAll(async () => {
    await conn?.close();
    await cluster?.stop();
  });

  async function triggerStateInDb(name: string, group: string): Promise<string | undefined> {
    const result = await conn.execute<[string]>(
      `SELECT TRIGGER_STATE FROM ${quartzTableName('TRIGGERS')}
        WHERE SCHED_NAME = :1 AND TRIGGER_NAME = :2 AND TRIGGER_GROUP = :3`,
      [cluster.schedulerName, name, group],
    );
    return result.rows?.[0]?.[0];
  }

  it('두 노드가 같은 스케줄러로 클러스터에 체크인한다', async () => {
    const metadata = await Promise.all([node1.client.metadata(), node2.client.metadata()]);
    expect(metadata.map((m) => m.instanceId)).toEqual(['node-1', 'node-2']);
    for (const m of metadata) {
      expect(m).toMatchObject({
        schedulerName: 'TestbedScheduler',
        clustered: true,
        started: true,
        standby: false,
      });
      expect(m.quartzVersion).toContain(QUARTZ_VERSION);
    }
    expect(await checkedInInstances(conn, { schedulerName: cluster.schedulerName })).toEqual([
      'node-1',
      'node-2',
    ]);
  });

  const repeating = { name: 'rec-every-500ms', group: 'smoke' };

  it('RecordingJob이 실행 기록을 남긴다', async () => {
    const firstFire = await node1.client.scheduleJob({
      job: { name: 'rec', group: 'smoke', type: 'RecordingJob', data: { label: 'smoke' } },
      trigger: { ...repeating, type: 'simple', intervalMs: 500 },
    });
    expect(firstFire).toEqual(expect.any(Number));

    const records = await waitForExecutions(
      conn,
      { jobName: 'rec', jobGroup: 'smoke', outcome: 'OK' },
      { min: 3 },
    );
    const record = records[0]!;
    expect(record).toMatchObject({
      schedName: 'TestbedScheduler',
      jobClass: 'RecordingJob',
      triggerName: repeating.name,
      triggerGroup: repeating.group,
      recovering: false,
      jobData: { label: 'smoke' },
    });
    expect(['node-1', 'node-2']).toContain(record.instanceId);
    expect(record.finishedAt).toBeGreaterThanOrEqual(record.startedAt);
    // 같은 발화가 두 노드에서 중복 실행되지 않는다
    const scheduled = records.map((r) => r.scheduledFireTime);
    expect(new Set(scheduled).size).toBe(scheduled.length);
  });

  it('HTTP API로 트리거를 일시정지하고 재개한다', async () => {
    // 다른 노드에서 일시정지해도 클러스터 전체에 적용된다
    expect(await node2.client.pauseTrigger(repeating)).toBeNull();
    expect(await node1.client.triggerState(repeating)).toBe('PAUSED');
    expect(await triggerStateInDb(repeating.name, repeating.group)).toBe('PAUSED');

    // 일시정지 직전에 이미 발화한 실행이 기록될 시간을 준다
    await sleep(1_500);
    const before = await listExecutions(conn, { jobName: 'rec', jobGroup: 'smoke' });
    await sleep(3_000);
    const during = await listExecutions(conn, { jobName: 'rec', jobGroup: 'smoke' });
    expect(during).toHaveLength(before.length);

    await node1.client.resumeTrigger(repeating);
    expect(await node2.client.triggerState(repeating)).toBe('NORMAL');
    await waitForExecutions(
      conn,
      { jobName: 'rec', jobGroup: 'smoke' },
      { min: before.length + 1 },
    );
  });

  it('HTTP API의 triggerJob으로 잡을 즉시 실행한다', async () => {
    const manual = { name: 'manual', group: 'smoke' };
    await node1.client.addJob({ ...manual, type: 'RecordingJob', durable: true });
    expect(await node1.client.job(manual)).toMatchObject({ durable: true });

    await node2.client.triggerJob(manual, { via: 'triggerJob' });
    const [record] = await waitForExecutions(conn, { jobName: 'manual', jobGroup: 'smoke' });
    // TRD §7.5: Quartz는 DEFAULT 그룹에 MT_ 접두어의 1회용 트리거를 만든다
    expect(record).toMatchObject({ triggerGroup: 'DEFAULT', jobData: { via: 'triggerJob' } });
    expect(record?.triggerName).toMatch(/^MT_/);
  });

  it('잡 일시정지는 그 잡의 트리거를 모두 PAUSED로 만든다', async () => {
    await node1.client.pauseJob({ name: 'rec', group: 'smoke' });
    expect(await triggerStateInDb(repeating.name, repeating.group)).toBe('PAUSED');
    await node1.client.resumeJob({ name: 'rec', group: 'smoke' });
    await waitFor(
      async () => (await triggerStateInDb(repeating.name, repeating.group)) !== 'PAUSED',
      {
        message: '트리거 재개',
      },
    );
  });

  it('스키마 변형(사용자 지정 prefix, 소문자, oracle23)을 같은 스키마에 만들 수 있다', async () => {
    await initQuartzSchema(conn, { prefix: 'APP_' });
    await initQuartzSchema(conn, { prefix: 'qa_', tableCase: 'lower' });
    await initQuartzSchema(conn, { prefix: 'B23_', variant: 'oracle23' });

    const result = await conn.execute<[string]>('SELECT TABLE_NAME FROM USER_TABLES');
    const tables = new Set((result.rows ?? []).map(([name]) => name));
    for (const schema of [
      {},
      { prefix: 'APP_' },
      { prefix: 'qa_', tableCase: 'lower' as const },
      { prefix: 'B23_' },
    ]) {
      for (const table of QUARTZ_TABLES) {
        expect(tables).toContain(quartzCatalogName(table, schema));
      }
    }
    expect(tables).toContain('TESTBED_EXECUTIONS');

    const boolType = await conn.execute<[string]>(
      `SELECT DATA_TYPE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = 'B23_JOB_DETAILS' AND COLUMN_NAME = 'IS_DURABLE'`,
    );
    expect(boolType.rows?.[0]?.[0]).toBe('BOOLEAN');
  });
});
