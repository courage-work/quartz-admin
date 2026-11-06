import type {
  DashboardResponse,
  QuartzDetection,
  SchedulerDetailDto,
  SchedulerDto,
  SnapshotDto,
} from '@qa/shared';
import {
  TargetError,
  TargetPoolManager,
  type BindValue,
  type DriverAdapter,
  type Row,
  type TargetConn,
} from '@qa/store';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp } from '../auth/test-support.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { tempDataDir } from '../meta-db/test-support.js';
import { QUARTZ_DETECTOR, type QuartzDetector } from '../targets/targets.service.js';
import { MonitorHooks, type MonitorOutcome } from './monitor-hooks.js';
import { MonitorService } from './monitor.service.js';

const features = {
  simpropTriggers: false,
  triggerPriority: true,
  firedPriority: true,
  firedSchedTime: true,
  jobNonconcurrent: true,
  jobUpdateData: true,
  cronTimeZone: true,
};

const detection: QuartzDetection = {
  schema: 'QUARTZ',
  dbNow: 0,
  tableSets: [
    {
      prefix: 'QRTZ_',
      tableNames: Object.fromEntries(
        [
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
        ].map((n) => [n, `QRTZ_${n}`]),
      ),
      features,
      boolFormat: '10',
      boolFormatSource: 'values',
      writeCapable: true,
      missingPrivileges: [],
      warnings: [],
      schedulers: [
        {
          schedName: 'S',
          jobCount: 1,
          triggerCount: 3,
          nodeCount: 2,
          activeNodeCount: 2,
          expectedNodeCount: 2,
        },
      ],
    },
  ],
  unusable: [],
};

/**
 * 호스트별로 정상·실패·무응답을 정하는 가짜 대상 DB. 감시 쿼리(collectMonitorData)에 맞는 행을 돌려준다.
 */
class FakeTarget {
  now = () => 0;
  /** 연결이 끝나지 않는 호스트 */
  readonly hung = new Set<string>();
  /** 연결이 실패하는 호스트 */
  readonly failing = new Map<string, TargetError>();
  overdueCount = 0;
  errorCount = 0;
  readonly connects: string[] = [];

  readonly adapter: DriverAdapter = {
    kind: 'oracle',
    connect: (info) => {
      this.connects.push(info.host);
      if (this.hung.has(info.host)) return new Promise<never>(() => undefined);
      const fail = this.failing.get(info.host);
      if (fail) return Promise.reject(fail);
      const conn: TargetConn = {
        kind: 'oracle',
        inTransaction: false,
        // 이미 열린 커넥션도 호스트 상태를 따른다(풀이 유휴 커넥션을 다시 쓰므로)
        query: <R extends Row = Row>(sql: string, _binds: readonly BindValue[] = []) => {
          if (this.hung.has(info.host)) return new Promise<never>(() => undefined);
          const failNow = this.failing.get(info.host);
          if (failNow) return Promise.reject(failNow);
          return Promise.resolve(this.answer(sql) as R[]);
        },
        execute: () => Promise.reject(new Error('감시는 쓰지 않는다')),
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      return Promise.resolve(conn);
    },
  };

  private answer(sql: string): Row[] {
    const now = this.now();
    if (sql.includes('SYSTIMESTAMP')) return [{ NOW_MS: now }];
    if (sql.includes('GROUP BY TRIGGER_STATE')) {
      return [
        { ST: 'WAITING', CNT: 3 },
        ...(this.errorCount > 0 ? [{ ST: 'ERROR', CNT: this.errorCount }] : []),
      ];
    }
    if (sql.includes('SCHEDULER_STATE')) {
      return [
        { N: 'node-1', L: now - 1_000, I: 7_500 },
        { N: 'node-2', L: now - 2_000, I: 7_500 },
      ];
    }
    if (sql.includes('NEXT_FIRE_TIME <') && sql.includes('COUNT(*)'))
      return [{ CNT: this.overdueCount }];
    if (sql.includes('NEXT_FIRE_TIME AS')) return [{ G: 'g', N: 'late', NFT: now - 600_000 }];
    if (sql.includes('FIRED_TRIGGERS')) return [{ CNT: 2 }];
    return [];
  }
}

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  cleanup?.();
  cleanup = undefined;
});

async function start(
  fake: FakeTarget,
  dataDir?: string,
  config?: Partial<TestApp['config']>,
): Promise<{ app: TestApp; cookie: string }> {
  const detector: QuartzDetector = () => Promise.resolve(structuredClone(detection));
  const app = await createTestApp({
    ...(dataDir ? { dataDir } : {}),
    ...(config ? { config } : {}),
    monitor: { enabled: true, roundTimeoutMs: 300 },
    overrides: [
      { provide: QUARTZ_DETECTOR, useValue: detector },
      {
        provide: TargetPoolManager,
        useValue: new TargetPoolManager([fake.adapter], {
          connectTimeoutMs: 200,
          acquireTimeoutMs: 200,
        }),
      },
    ],
  });
  t = app;
  fake.now = () => app.clock.now;
  return { app, cookie: await app.login(ADMIN.username, ADMIN.password) };
}

async function addScheduler(app: TestApp, cookie: string, host: string): Promise<SchedulerDto> {
  const conn = await app
    .send(
      'post',
      '/connections',
      {
        name: host,
        dbType: 'oracle',
        host,
        port: 1521,
        oracleServiceName: 'PDB',
        username: 'u',
        password: 'p',
        envLabel: 'dev',
      },
      cookie,
    )
    .expect(201);
  const res = await app
    .send(
      'post',
      `/connections/${(conn.body as { id: number }).id}/schedulers`,
      { selections: [{ prefix: 'QRTZ_', schedName: 'S' }] },
      cookie,
    )
    .expect(201);
  return (res.body as SchedulerDto[])[0]!;
}

async function snapshotOf(app: TestApp, cookie: string, id: number): Promise<SnapshotDto | null> {
  const res = await app.get(`/schedulers/${id}/snapshot`, cookie).expect(200);
  return (res.body as { snapshot: SnapshotDto | null }).snapshot;
}

/** 조건이 맞을 때까지 기다린다(실제 타이머) */
async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  ms = 3_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('시간 안에 조건을 만족하지 못했습니다');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('감시 루프 (B-15, TRD §9.1)', () => {
  it('등록하면 바로 감시해 스냅샷과 known_nodes를 남긴다', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const s = await addScheduler(app, cookie, 'db-ok');

    const snap = await until(() => snapshotOf(app, cookie, s.id));
    expect(snap).toMatchObject({
      schedulerId: s.id,
      status: 'ok',
      dbNow: app.clock.now,
      clockSkewMs: 0,
      triggerCounts: { WAITING: 3 },
      executingCount: 2,
      errorCode: null,
      consecutiveFailures: 0,
    });
    expect(snap.nodes?.map((n) => [n.instanceName, n.active])).toEqual([
      ['node-1', true],
      ['node-2', true],
    ]);
    const known = app.app
      .get(MetaDbService)
      .sqlite.prepare(
        'SELECT instance_name, last_checkin_time FROM known_nodes WHERE scheduler_id = ? ORDER BY 1',
      )
      .all(s.id);
    expect(known).toEqual([
      { instance_name: 'node-1', last_checkin_time: app.clock.now - 1_000 },
      { instance_name: 'node-2', last_checkin_time: app.clock.now - 2_000 },
    ]);
  });

  it('연체·ERROR 트리거와 노드 부족을 상태에 반영한다', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const s = await addScheduler(app, cookie, 'db-ok');
    await until(() => snapshotOf(app, cookie, s.id));
    const monitor = app.app.get(MonitorService);

    fake.overdueCount = 1;
    expect((await monitor.poll(s.id))?.status).toBe('warning');
    fake.errorCount = 2;
    expect((await monitor.poll(s.id))?.status).toBe('critical');
  });

  it('연결하지 못하면 unreachable과 원인을 남기고, 마지막 성공 값은 유지하며 연속 실패를 센다', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const s = await addScheduler(app, cookie, 'db-flaky');
    await until(() => snapshotOf(app, cookie, s.id));
    const monitor = app.app.get(MonitorService);

    fake.failing.set('db-flaky', new TargetError('TARGET_AUTH_FAILED'));
    await monitor.poll(s.id);
    const failed = await monitor.poll(s.id);
    expect(failed).toMatchObject({
      status: 'unreachable',
      errorCode: 'TARGET_AUTH_FAILED',
      consecutiveFailures: 2,
      triggerCounts: { WAITING: 3 },
      executingCount: 2,
    });

    fake.failing.clear();
    expect(await monitor.poll(s.id)).toMatchObject({
      status: 'ok',
      errorCode: null,
      consecutiveFailures: 0,
    });
  });

  it('응답하지 않는 대상은 회차 제한 안에 실패로 끝나고, 다른 스케줄러의 감시는 그대로 성공한다', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const hungS = await addScheduler(app, cookie, 'db-hung');
    const okS = await addScheduler(app, cookie, 'db-ok');
    // 등록(감지)이 끝난 뒤부터 응답하지 않게 한다
    fake.hung.add('db-hung');
    void app.app.get(MonitorService).poll(hungS.id);

    const okSnap = await until(() => snapshotOf(app, cookie, okS.id));
    expect(okSnap.status).toBe('ok');
    const hungSnap = await until(async () => {
      const snap = await snapshotOf(app, cookie, hungS.id);
      return snap?.status === 'unreachable' ? snap : null;
    });
    expect(hungSnap.errorCode).toBe('TARGET_TIMEOUT');

    // 무응답 대상이 있어도 다른 스케줄러의 감시 1회는 바로 끝난다
    const started = Date.now();
    expect((await app.app.get(MonitorService).poll(okS.id))?.status).toBe('ok');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('설정 변경과 삭제를 감시 루프에 바로 반영한다', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const s = await addScheduler(app, cookie, 'db-ok');
    const monitor = app.app.get(MonitorService);
    expect(monitor.isTracking(s.id)).toBe(true);

    await app
      .send(
        'put',
        `/schedulers/${s.id}/settings`,
        {
          displayName: 'x',
          misfireThresholdMs: 60_000,
          overdueGraceMs: 60_000,
          checkinMultiplier: 3,
          expectedNodeCount: 5,
          pollIntervalSec: 15,
        },
        cookie,
      )
      .expect(200);
    // 기대 노드 수가 늘었으니 다음 감시부터 warning이다
    expect((await monitor.poll(s.id))?.status).toBe('warning');

    await app.send('delete', `/schedulers/${s.id}`, undefined, cookie).expect(204);
    expect(monitor.isTracking(s.id)).toBe(false);
    expect(await monitor.poll(s.id)).toBeNull();
  });

  it('감시 결과를 같은 트랜잭션 안에서 확장 지점(훅)에 넘긴다', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const seen: MonitorOutcome[] = [];
    app.app.get(MonitorHooks).register({ name: 'test', afterPoll: (o) => seen.push(o) });
    const s = await addScheduler(app, cookie, 'db-ok');
    await until(() => Promise.resolve(seen.length > 0));
    expect(seen[0]).toMatchObject({
      ok: true,
      scheduler: { id: s.id },
      snapshot: { status: 'ok' },
    });
    expect(seen[0]!.ok && seen[0]!.data.overdue).toEqual([]);

    fake.overdueCount = 1;
    await app.app.get(MonitorService).poll(s.id);
    const last = seen.at(-1)!;
    expect(last.ok && last.data.overdue).toEqual([
      { group: 'g', name: 'late', nextFireTime: app.clock.now - 600_000 },
    ]);
  });

  it('도구를 재시작하면 등록된 스케줄러의 감시가 자동으로 다시 시작된다', async () => {
    const tmp = tempDataDir();
    cleanup = tmp.cleanup;
    const fake = new FakeTarget();
    const first = await start(fake, tmp.dir);
    const s = await addScheduler(first.app, first.cookie, 'db-ok');
    await until(() => snapshotOf(first.app, first.cookie, s.id));
    await first.app.close();
    t = undefined;

    // 같은 데이터 디렉터리와 같은 암호화 키로 다시 띄운다. 시계를 옮겨 새 스냅샷을 구분한다
    const second = await start(fake, tmp.dir, { encryption: first.app.config.encryption });
    second.app.clock.advance(3_600_000);
    const monitor = second.app.app.get(MonitorService);
    expect(monitor.isTracking(s.id)).toBe(true);
    expect(monitor.stats.scheduled).toBe(1);
    // 첫 회차는 지터(최대 15초) 뒤에 돌므로 여기서는 직접 한 번 돌려 결과가 쌓이는지 본다
    const snap = await monitor.poll(s.id);
    expect(snap).toMatchObject({ status: 'ok', polledAt: second.app.clock.now });
  });

  it('대시보드는 스냅샷만 읽어, 응답하지 않는 대상이 섞여 있어도 p95 3초 안에 응답한다 (NFR-PERF-01)', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const hungS = await addScheduler(app, cookie, 'db-hung');
    const okS = await addScheduler(app, cookie, 'db-ok');
    fake.hung.add('db-hung');
    await until(() => snapshotOf(app, cookie, okS.id));
    // 무응답 대상의 감시가 도는 중에도 대시보드를 부른다
    void app.app.get(MonitorService).poll(hungS.id);

    const timings: number[] = [];
    let last: DashboardResponse | undefined;
    for (let i = 0; i < 20; i++) {
      const started = Date.now();
      last = (await app.get('/schedulers', cookie).expect(200)).body as DashboardResponse;
      timings.push(Date.now() - started);
    }
    timings.sort((a, b) => a - b);
    expect(timings[Math.ceil(timings.length * 0.95) - 1]!).toBeLessThan(3_000);
    expect(last!.items.map((i) => i.connection.name)).toEqual(['db-hung', 'db-ok']);
    expect(last!.items[1]).toMatchObject({
      id: okS.id,
      schedName: 'S',
      connection: { envLabel: 'dev', dbType: 'oracle' },
      snapshot: { status: 'ok', executingCount: 2 },
      openAlertCount: 0,
    });
    expect(last!.envs).toEqual(['dev']);
  });

  it('대시보드 필터(환경, 태그, 이름)와 스케줄러 상세의 접속 요약·스냅샷', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const s = await addScheduler(app, cookie, 'db-ok');
    await until(() => snapshotOf(app, cookie, s.id));
    const conn = (await app.get('/connections', cookie)).body as { id: number }[];
    await app
      .send(
        'put',
        `/connections/${conn[0]!.id}`,
        {
          name: '정산',
          dbType: 'oracle',
          host: 'db-ok',
          port: 1521,
          oracleServiceName: 'PDB',
          username: 'u',
          password: '',
          envLabel: 'prod',
          tags: ['정산', '배치'],
        },
        cookie,
      )
      .expect(200);

    const names = async (query: string) =>
      (
        (await app.get(`/schedulers${query}`, cookie).expect(200)).body as DashboardResponse
      ).items.map((i) => i.connection.name);
    expect(await names('?env=PROD')).toEqual(['정산']);
    expect(await names('?env=dev')).toEqual([]);
    expect(await names('?tag=배치')).toEqual(['정산']);
    expect(await names('?q=s')).toEqual(['정산']);
    expect(await names('?q=nothing')).toEqual([]);

    const detail = (await app.get(`/schedulers/${s.id}`, cookie).expect(200))
      .body as SchedulerDetailDto;
    expect(detail).toMatchObject({
      id: s.id,
      schedName: 'S',
      connection: { name: '정산', envLabel: 'prod', tags: ['정산', '배치'] },
      snapshot: { status: 'ok' },
      openAlertCount: 0,
    });
  });
});
