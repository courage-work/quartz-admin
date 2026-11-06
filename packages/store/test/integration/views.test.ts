import type oracledb from 'oracledb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_GROUPS_PAUSED,
  OracleAdapter,
  collectMonitorData,
  QUARTZ_REQUIRED_TABLES,
  TargetPoolManager,
  createTableSet,
  getJobDetail,
  listExecuting,
  listJobs,
  listNodes,
  listPausedGroups,
  listTriggers,
  oracleDialect,
  queryDbNowMillis,
  type PoolTarget,
  type SchedulerViewContext,
} from '../../src/index.js';
import { initQuartzSchema, startOracle, type OracleFixture } from '../support/index.js';

const SCHED = 'Views';
const TRIGGER_COUNT = 10_000;
/** 특수 문자가 들어간 그룹. 정확히 일치로만 찾혀야 한다 */
const SPECIAL_GROUP = 'grp%_/1';
const SPECIAL_NAMES = ['a%b', 'a_b', 'a/b', 'axb'];
/** 일반 트리거 + 특수 문자 그룹 + 정확히 일치 검증용 decoy 1개 */
const TOTAL = TRIGGER_COUNT + SPECIAL_NAMES.length + 1;

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
 * 조회 API의 쿼리 (B-14, TRD §8). 트리거 10,000개 스케줄러에서 목록 응답 시간과
 * `%`, `_`, `/`가 들어간 그룹·이름 조회를 확인한다.
 */
describe('조회 쿼리 (Oracle Free 23)', () => {
  let oracle: OracleFixture;
  let pools: TargetPoolManager;
  let target: PoolTarget;
  let ctx: SchedulerViewContext;
  let dbNow: number;

  const run = <T>(
    fn: (conn: Parameters<Parameters<TargetPoolManager['withConnection']>[1]>[0]) => Promise<T>,
  ) => pools.withConnection(target, fn);

  beforeAll(async () => {
    oracle = await startOracle();
    pools = new TargetPoolManager([new OracleAdapter()]);
    target = {
      id: 'views',
      info: {
        kind: 'oracle',
        host: oracle.container.getHost(),
        port: oracle.container.getMappedPort(1521),
        username: oracle.user,
        password: oracle.password,
        oracleServiceName: 'FREEPDB1',
      },
    };
    ctx = {
      dialect: oracleDialect,
      tables: createTableSet(oracleDialect, {
        schema: oracle.user,
        tables: {
          ...Object.fromEntries(QUARTZ_REQUIRED_TABLES.map((t) => [t, `QRTZ_${t}`])),
          SIMPROP_TRIGGERS: 'QRTZ_SIMPROP_TRIGGERS',
        },
      }),
      features,
      schedName: SCHED,
    };
    dbNow = await run((c) => queryDbNowMillis(c, oracleDialect));
    await oracle.withConnection(async (conn) => {
      await initQuartzSchema(conn);
      await seed(conn, dbNow);
    });
  });

  afterAll(async () => {
    await pools?.closeAll();
    await oracle?.stop();
  });

  it('트리거 10,000개 스케줄러에서 목록 페이지 응답이 p95 2초 이내다', async () => {
    const queries = [
      { sort: 'key' as const, page: 1, size: 50 },
      { sort: 'key' as const, page: 200, size: 50 },
      { sort: 'nextFireTime' as const, page: 1, size: 200 },
      { sort: 'nextFireTime' as const, page: 40, size: 50 },
      { state: ['WAITING' as const, 'PAUSED' as const], sort: 'key' as const, page: 3, size: 100 },
      { type: ['CRON' as const], sort: 'nextFireTime' as const, page: 1, size: 50 },
      { q: 'trig-09', sort: 'key' as const, page: 1, size: 50 },
      { group: 'group-07', sort: 'key' as const, page: 2, size: 50 },
    ];
    const timings: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const query of queries) {
        const started = performance.now();
        // API와 같이 DB 시각을 먼저 읽고 목록을 읽는다
        const result = await run(async (conn) => {
          await queryDbNowMillis(conn, oracleDialect);
          return listTriggers(conn, ctx, query);
        });
        timings.push(performance.now() - started);
        expect(result.items.length, JSON.stringify(query)).toBeGreaterThan(0);
      }
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
    console.log(
      `트리거 목록 ${timings.length}회: p50 ${timings[timings.length >> 1]!.toFixed(0)}ms, p95 ${p95.toFixed(0)}ms`,
    );
    expect(p95).toBeLessThan(2_000);
  });

  it('목록은 전체 개수와 정렬된 페이지를 돌려주고, 일정을 타입별로 채운다', async () => {
    const all = await run((c) => listTriggers(c, ctx, { sort: 'key', page: 1, size: 3 }));
    expect(all.total).toBe(TOTAL);
    expect(all.items.map((t) => `${t.group}/${t.name}`)).toEqual([
      'group-00/trig-00000',
      'group-00/trig-00020',
      'group-00/trig-00040',
    ]);
    const first = all.items[0]!;
    expect(first).toMatchObject({
      type: 'CRON',
      jobGroup: 'jobs',
      priority: 5,
      misfireInstruction: 0,
    });
    expect(first.cron).toEqual({ expression: '0 0/5 * * * ?', timeZone: 'Asia/Seoul' });
    expect(first.simple).toBeNull();

    const simple = await run((c) =>
      listTriggers(c, ctx, { type: ['SIMPLE'], sort: 'key', page: 1, size: 1 }),
    );
    expect(simple.items[0]!.simple).toEqual({
      repeatCount: -1,
      repeatIntervalMs: 60_000,
      timesTriggered: 3,
    });
    expect(simple.items[0]!.cron).toBeNull();

    // 다음 실행 시각이 없는(-1) 트리거는 맨 뒤로 간다
    const byNext = await run((c) =>
      listTriggers(c, ctx, { sort: 'nextFireTime', page: 1, size: 1 }),
    );
    expect(byNext.items[0]!.nextFireTime).toBe(dbNow + 1_000);
    const last = await run((c) =>
      listTriggers(c, ctx, { sort: 'nextFireTime', page: TOTAL, size: 1 }),
    );
    expect(last.items[0]!.nextFireTime).toBeNull();
  });

  it('그룹명에 %, _, /가 있어도 정확히 그 그룹만 찾는다', async () => {
    const res = await run((c) =>
      listTriggers(c, ctx, { group: SPECIAL_GROUP, sort: 'key', page: 1, size: 50 }),
    );
    expect(res.total).toBe(SPECIAL_NAMES.length);
    expect(res.items.map((t) => t.name).sort()).toEqual([...SPECIAL_NAMES].sort());

    // LIKE로 비교했다면 grp%_/1 패턴이 grpX_/1 같은 그룹도 찾았을 것이다
    const decoy = await run((c) =>
      listTriggers(c, ctx, { group: 'grpX_/1', sort: 'key', page: 1, size: 50 }),
    );
    expect(decoy.total).toBe(1);
  });

  it.each([
    ['a%b', ['a%b']],
    ['a_b', ['a_b']],
    ['a/b', ['a/b']],
    // 이스케이프하지 않았다면 a로 시작하는 이름 네 개가 모두 걸린다
    ['a%', ['a%b']],
    ['a_', ['a_b']],
    // 그룹명(grp%_/1)에도 검색어를 걸므로 %_/는 그룹으로 네 개가 모두 찾힌다
    ['%_/', SPECIAL_NAMES],
  ])('검색어 %j는 글자 그대로 찾는다', async (q, expected) => {
    const res = await run((c) =>
      listTriggers(c, ctx, { group: SPECIAL_GROUP, q, sort: 'key', page: 1, size: 50 }),
    );
    expect(res.items.map((t) => t.name).sort()).toEqual([...expected].sort());
  });

  it('잡 목록과 상세: 트리거 수, 불리언, 이름에 /와 %가 있는 잡, JobDataMap 원본', async () => {
    const jobs = await run((c) => listJobs(c, ctx, { page: 1, size: 50 }));
    expect(jobs.total).toBe(3);
    const byName = Object.fromEntries(jobs.items.map((j) => [j.name, j]));
    expect(byName['job-a']).toMatchObject({
      group: 'jobs',
      triggerCount: TRIGGER_COUNT / 2,
      durable: true,
      nonConcurrent: false,
    });
    // decoy 트리거도 job-b에 붙어 있다
    expect(byName['job-b']!.triggerCount).toBe(TRIGGER_COUNT / 2 + 1);

    const search = await run((c) => listJobs(c, ctx, { q: '100%', page: 1, size: 50 }));
    expect(search.items.map((j) => j.name)).toEqual(['report/100%']);

    const detail = await run((c) =>
      getJobDetail(c, ctx, { group: SPECIAL_GROUP, name: 'report/100%' }),
    );
    expect(detail?.job).toMatchObject({
      jobClass: 'x.Report',
      requestsRecovery: true,
      triggerCount: SPECIAL_NAMES.length,
    });
    expect(detail?.triggers.map((t) => t.name).sort()).toEqual([...SPECIAL_NAMES].sort());
    expect(detail?.jobData?.toString('latin1')).toContain('owner=ops');

    const serialized = await run((c) => getJobDetail(c, ctx, { group: 'jobs', name: 'job-a' }));
    expect(serialized?.jobData?.subarray(0, 2)).toEqual(Buffer.from([0xac, 0xed]));

    expect(await run((c) => getJobDetail(c, ctx, { group: 'jobs', name: 'nope' }))).toBeNull();
  });

  it('감시 1회 수집: 상태별 개수, 노드, 실행 중 수, 연체 수와 상위 목록, ERROR·BLOCKED 목록 (B-15)', async () => {
    // 시드의 다음 실행 시각은 모두 미래(seed dbNow + 1초 간격)다. 연체 기준을 seed dbNow + 4.5초로 옮겨
    // 앞쪽 트리거(i=0~3)만 연체가 되게 한다. 앞선 테스트로 DB 시각이 흘렀으므로 지금 시각에서 거꾸로 계산한다
    const data = await run(async (c) => {
      const current = await queryDbNowMillis(c, oracleDialect);
      return collectMonitorData(c, ctx, {
        checkinMultiplier: 3,
        overdueAfterMs: current - (dbNow + 4_500),
      });
    });
    const waiting = data.triggerCounts.WAITING ?? 0;
    expect(waiting + (data.triggerCounts.PAUSED ?? 0) + (data.triggerCounts.BLOCKED ?? 0)).toBe(
      TOTAL,
    );
    expect(data.triggerCounts.PAUSED).toBe(TRIGGER_COUNT / 10);
    expect(data.nodes.map((n) => [n.instanceName, n.active])).toEqual([
      ['node-dead', false],
      ['node-live', true],
    ]);
    expect(data.executingCount).toBe(3);
    // i=1,2,3(WAITING)의 다음 실행 시각이 dbNow+2초~4초, i=0은 PAUSED라 빠진다
    expect(data.overdueCount).toBe(3);
    expect(data.overdue.map((t) => t.name)).toEqual(['trig-00001', 'trig-00002', 'trig-00003']);
    expect(data.errorTriggers).toEqual([]);
    // 목록은 상한(기본 500)까지만 읽는다. 개수는 triggerCounts에 있다
    expect(data.blockedTriggers.length).toBe(Math.min(data.triggerCounts.BLOCKED ?? 0, 500));
    expect(data.blockedTriggers.every((t) => t.state === 'BLOCKED')).toBe(true);
  });

  it('노드 활성 판정, 일시정지 그룹, 실행 중 목록의 오래된 기록 구분', async () => {
    const opts = { dbNow, checkinMultiplier: 3 };
    const nodes = await run((c) => listNodes(c, ctx, opts));
    expect(nodes.map((n) => [n.instanceName, n.active])).toEqual([
      ['node-dead', false],
      ['node-live', true],
    ]);

    expect(await run((c) => listPausedGroups(c, ctx))).toEqual([ALL_GROUPS_PAUSED, 'group-03']);

    const executing = await run((c) => listExecuting(c, ctx, opts));
    expect(executing.map((e) => [e.entryId, e.state, e.stale])).toEqual([
      ['e-dead', 'EXECUTING', true],
      ['e-live', 'EXECUTING', false],
      ['e-acq', 'ACQUIRED', false],
    ]);
    expect(executing[1]).toMatchObject({ jobName: 'job-a', elapsedMs: 5_000, priority: 5 });
  });
});

/** Quartz 테이블에 조회용 데이터를 넣는다. 트리거는 executeMany로 한 번에 넣는다 */
async function seed(conn: oracledb.Connection, now: number): Promise<void> {
  const serialized = Buffer.from([0xac, 0xed, 0x00, 0x05, 0x73, 0x72, 0x00, 0x15]);
  const properties = Buffer.from('#Quartz\nowner=ops\nretry=3\n', 'latin1');
  await conn.executeMany(
    `INSERT INTO QRTZ_JOB_DETAILS (SCHED_NAME, JOB_NAME, JOB_GROUP, JOB_CLASS_NAME, IS_DURABLE,
       IS_NONCONCURRENT, IS_UPDATE_DATA, REQUESTS_RECOVERY, JOB_DATA)
     VALUES (:1, :2, :3, :4, '1', '0', '0', :5, :6)`,
    [
      [SCHED, 'job-a', 'jobs', 'x.JobA', '0', serialized],
      [SCHED, 'job-b', 'jobs', 'x.JobB', '0', null],
      [SCHED, 'report/100%', SPECIAL_GROUP, 'x.Report', '1', properties],
    ],
  );

  const triggers: unknown[][] = [];
  const crons: unknown[][] = [];
  const simples: unknown[][] = [];
  for (let i = 0; i < TRIGGER_COUNT; i++) {
    const name = `trig-${String(i).padStart(5, '0')}`;
    const group = `group-${String(i % 20).padStart(2, '0')}`;
    const cron = i % 2 === 0;
    const state = i % 10 === 0 ? 'PAUSED' : i % 7 === 0 ? 'BLOCKED' : 'WAITING';
    // 마지막 트리거는 다음 실행 시각이 없다(-1)
    const next = i === TRIGGER_COUNT - 1 ? -1 : now + 1_000 + i * 1_000;
    triggers.push([
      SCHED,
      name,
      group,
      cron ? 'job-a' : 'job-b',
      'jobs',
      next,
      state,
      cron ? 'CRON' : 'SIMPLE',
      now - 60_000,
    ]);
    if (cron) crons.push([SCHED, name, group, '0 0/5 * * * ?', 'Asia/Seoul']);
    else simples.push([SCHED, name, group, -1, 60_000, 3]);
  }
  for (const [i, name] of SPECIAL_NAMES.entries()) {
    triggers.push([
      SCHED,
      name,
      SPECIAL_GROUP,
      'report/100%',
      SPECIAL_GROUP,
      now + 2_000_000 + i,
      'WAITING',
      'CRON',
      now,
    ]);
    crons.push([SCHED, name, SPECIAL_GROUP, '0 0 * * * ?', null]);
  }
  // LIKE였다면 SPECIAL_GROUP 패턴에 걸렸을 그룹(정확히 일치 검증용)
  triggers.push([
    SCHED,
    'decoy',
    'grpX_/1',
    'job-b',
    'jobs',
    now + 3_000_000,
    'WAITING',
    'SIMPLE',
    now,
  ]);
  simples.push([SCHED, 'decoy', 'grpX_/1', 0, 0, 0]);
  await conn.executeMany(
    `INSERT INTO QRTZ_TRIGGERS (SCHED_NAME, TRIGGER_NAME, TRIGGER_GROUP, JOB_NAME, JOB_GROUP,
       NEXT_FIRE_TIME, PREV_FIRE_TIME, PRIORITY, TRIGGER_STATE, TRIGGER_TYPE, START_TIME, MISFIRE_INSTR)
     VALUES (:1, :2, :3, :4, :5, :6, -1, 5, :7, :8, :9, 0)`,
    triggers,
  );
  await conn.executeMany(`INSERT INTO QRTZ_CRON_TRIGGERS VALUES (:1, :2, :3, :4, :5)`, crons);
  await conn.executeMany(
    `INSERT INTO QRTZ_SIMPLE_TRIGGERS VALUES (:1, :2, :3, :4, :5, :6)`,
    simples,
  );

  await conn.executeMany(`INSERT INTO QRTZ_SCHEDULER_STATE VALUES (:1, :2, :3, :4)`, [
    [SCHED, 'node-live', now - 1_000, 7_500],
    [SCHED, 'node-dead', now - 600_000, 7_500],
  ]);
  await conn.executeMany(`INSERT INTO QRTZ_PAUSED_TRIGGER_GRPS VALUES (:1, :2)`, [
    [SCHED, 'group-03'],
    [SCHED, ALL_GROUPS_PAUSED],
  ]);
  await conn.executeMany(
    `INSERT INTO QRTZ_FIRED_TRIGGERS (SCHED_NAME, ENTRY_ID, TRIGGER_NAME, TRIGGER_GROUP, INSTANCE_NAME,
       FIRED_TIME, SCHED_TIME, PRIORITY, STATE, JOB_NAME, JOB_GROUP, IS_NONCONCURRENT, REQUESTS_RECOVERY)
     VALUES (:1, :2, :3, :4, :5, :6, :7, 5, :8, :9, 'jobs', '0', '0')`,
    [
      [
        SCHED,
        'e-dead',
        'trig-00002',
        'group-02',
        'node-dead',
        now - 900_000,
        now - 900_000,
        'EXECUTING',
        'job-a',
      ],
      [
        SCHED,
        'e-live',
        'trig-00004',
        'group-04',
        'node-live',
        now - 5_000,
        now - 5_000,
        'EXECUTING',
        'job-a',
      ],
      [SCHED, 'e-acq', 'trig-00006', 'group-06', 'node-live', now, now, 'ACQUIRED', null],
    ],
  );
  await conn.commit();
}
