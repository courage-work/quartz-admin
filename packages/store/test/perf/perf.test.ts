import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConnectionDto,
  DashboardResponse,
  DetectionDto,
  SchedulerDto,
  SnapshotDto,
} from '@qa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDriverAdapters } from '../../src/registry.js';
import {
  collectMonitorData,
  detectQuartz,
  getJobDetail,
  getTriggerDetail,
  listExecuting,
  listJobs,
  listNodes,
  listTriggers,
} from '../../src/index.js';
import {
  TEST_DB,
  TEST_DB_LABEL,
  initQuartzSchema,
  schedulerContext,
  sleep,
  startTestDb,
  type DbFixture,
  type TestConnection,
} from '../support/index.js';
import { ApiError, startApi } from './api-harness.js';
import { Verdicts, countingConn, ms, summarize, table, timed, type Summary } from './measure.js';
import {
  DEFAULT_SEED,
  expectedCounts,
  perfGroup,
  perfJobName,
  perfTriggerName,
  seedPerfData,
  startHeartbeat,
  type PerfSeedOptions,
  type SeedResult,
} from './seed.js';

/**
 * 성능·규모 검증 (B-31, PRD §7.2 NFR-PERF-01~04). `pnpm --filter @qa/store perf`로 손으로 돌린다. Docker와 빌드한 API(`pnpm build`)가 필요하다.
 *
 * 1. 조회 계층: 제품 어댑터로 감시 1회와 목록 조회의 시간·쿼리 왕복 수를 잰다
 * 2. API 계층: 빌드한 API를 띄워 스케줄러를 등록하고, 실제 감시 루프가 도는 동안 대시보드·목록 응답 시간,
 *    감시 간격, 대상 DB 세션 수를 잰다. 접속 배치는 `single`(접속 1개에 스케줄러 전부)과 `spread`(접속 10개에 나눠서)
 *
 * 결과는 `QA_PERF_REPORT_DIR`(기본 레포 루트 `perf-results/`)에 마크다운으로 남긴다. 목표를 넘은 항목이 있으면 마지막에 실패한다.
 */
const env = process.env;
const SEED: PerfSeedOptions = {
  ...DEFAULT_SEED,
  schedulers: Number(env.QA_PERF_SCHEDULERS ?? DEFAULT_SEED.schedulers),
  triggersPerScheduler: Number(env.QA_PERF_TRIGGERS ?? DEFAULT_SEED.triggersPerScheduler),
};
const LAYOUTS = (env.QA_PERF_LAYOUTS ?? 'single,spread').split(',').filter(Boolean);
const OBSERVE_SEC = Number(env.QA_PERF_OBSERVE_SEC ?? 150);
const REPEAT = Number(env.QA_PERF_REPEAT ?? 20);
/** 동시 사용자 수 가정 (PRD §7.2) */
const USERS = 20;
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const REPORT_DIR = env.QA_PERF_REPORT_DIR ?? path.join(REPO, 'perf-results');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
/** 측정이 끝난 뒤(접속 1개 배치) API를 띄워 둘 시간(분). 화면 첫 렌더를 확인할 때 쓴다 */
const HOLD_MIN = Number(env.QA_PERF_HOLD_MIN ?? 0);

/** NFR 목표(ms) */
const TARGET = {
  dashboardP95: 3_000,
  listP95: 2_000,
  pollIntervalMs: 60_000,
  /** 감시 간격 허용 오차. 다음 회차는 계획 시각 + 주기라 회차 소요 시간만큼 흔들린다 */
  intervalSlackMs: 5_000,
  connectionsPerTarget: 2,
} as const;

const report: string[] = [];
const verdicts = new Verdicts();
const log = (msg: string) => console.log(`[perf ${TEST_DB}] ${msg}`);

function summaryRow(name: string, s: Summary, extra: (string | number)[] = []) {
  return [name, s.n, ms(s.p50), ms(s.p95), ms(s.max), ...extra];
}

describe(`성능·규모 (${TEST_DB_LABEL}, 스케줄러 ${SEED.schedulers} × 트리거 ${SEED.triggersPerScheduler})`, () => {
  let db: DbFixture;
  let seed: SeedResult;
  let heartbeat: { stop(): Promise<void> } | undefined;

  beforeAll(async () => {
    mkdirSync(REPORT_DIR, { recursive: true });
    db = await startTestDb();
    await db.withConnection(async (conn) => initQuartzSchema(conn));
    seed = await seedPerfData(db, SEED, log);
    heartbeat = await startHeartbeat(db);
    report.push(
      `# 성능·규모 측정 (${TEST_DB_LABEL})`,
      '',
      `- 시각: ${new Date().toISOString()}`,
      `- 규모: 스케줄러 ${SEED.schedulers}개 × 트리거 ${SEED.triggersPerScheduler}개(잡도 같은 수), 노드 ${SEED.nodes}개, Quartz 테이블 한 벌`,
      `- 합성 데이터 생성: ${(seed.elapsedMs / 1_000).toFixed(1)}초`,
      `- 반복: 조회마다 ${REPEAT}회, 동시 사용자 ${USERS}명, 감시 관찰 ${OBSERVE_SEC}초`,
      '',
    );
  });

  afterAll(async () => {
    await heartbeat?.stop();
    await db?.stop();
    report.push('## 판정', '', verdicts.render(), '');
    const file = path.join(REPORT_DIR, `${TEST_DB}-${STAMP}.md`);
    writeFileSync(file, report.join('\n'));
    log(`결과: ${file}`);
  });

  it('조회 계층: 접속 감지', async () => {
    const adapter = createDriverAdapters().find((a) => a.kind === db.dbKind)!;
    const conn = countingConn(
      await adapter.connect(db.targetInfo(), { connectTimeoutMs: 10_000, queryTimeoutMs: 30_000 }),
    );
    try {
      await detectQuartz(conn, db.dialect);
      const samples: number[] = [];
      const perStatement = new Map<string, number[]>();
      for (let r = 0; r < 3; r++) {
        conn.reset();
        const { value, ms: t } = await timed(() => detectQuartz(conn, db.dialect));
        samples.push(t);
        expect(value.tableSets[0]?.schedulers).toHaveLength(SEED.schedulers);
        for (const q of conn.log) {
          const list = perStatement.get(q.sql) ?? [];
          list.push(q.ms);
          perStatement.set(q.sql, list);
        }
      }
      const s = summarize(samples);
      const slowest = [...perStatement]
        .map(([sql, list]) => ({ sql, ms: summarize(list).p50 }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5);
      report.push(
        '## 0. 접속 감지 (`detectQuartz`, 목표 없음)',
        '',
        `- 감지 1회: ${s.n}회, p50 ${ms(s.p50)}ms, 최대 ${ms(s.max)}ms, 문장 ${conn.calls}개`,
        '',
        table(
          ['느린 문장(중앙값)', 'ms'],
          slowest.map((q) => [`\`${q.sql.replace(/\s+/g, ' ').slice(0, 140)}\``, ms(q.ms)]),
        ),
        '',
      );
    } finally {
      await conn.close();
    }
  });

  it('조회 계층: 감시 1회와 목록 조회', async () => {
    const adapter = createDriverAdapters().find((a) => a.kind === db.dbKind)!;
    const conn = countingConn(
      await adapter.connect(db.targetInfo(), { connectTimeoutMs: 10_000, queryTimeoutMs: 10_000 }),
    );
    try {
      // 감시 1회: 스케줄러마다 한 번씩(앞의 3개로 데우기)
      const ctxs = seed.schedNames.map((name) => schedulerContext(db, name));
      const opts = { checkinMultiplier: 3, overdueAfterMs: 120_000 };
      for (const ctx of ctxs.slice(0, 3)) await collectMonitorData(conn, ctx, opts);
      const pollMs: number[] = [];
      const pollCalls: number[] = [];
      let lastCounts: Record<string, number> = {};
      for (const ctx of ctxs) {
        conn.reset();
        const { value, ms: t } = await timed(() => collectMonitorData(conn, ctx, opts));
        pollMs.push(t);
        pollCalls.push(conn.calls);
        lastCounts = value.triggerCounts;
        expect(value.overdue.length).toBe(expectedCounts(SEED.triggersPerScheduler).overdue);
      }
      const poll = summarize(pollMs);
      const cycleMs = pollMs.reduce((a, b) => a + b, 0);
      const calls = [...new Set(pollCalls)].join(', ');
      report.push(
        '## 1. 조회 계층 (제품 어댑터, 커넥션 1개)',
        '',
        '### 감시 1회 (`collectMonitorData`)',
        '',
        table(
          ['측정', '횟수', 'p50', 'p95', '최대', '쿼리 왕복'],
          [summaryRow('스케줄러마다 1회', poll, [calls])],
        ),
        '',
        `- 스케줄러 ${SEED.schedulers}개를 커넥션 1개로 차례로 감시하면 ${(cycleMs / 1_000).toFixed(1)}초(접속당 최대 2개면 그 절반)`,
        `- 상태별 트리거 수(마지막 스케줄러): ${JSON.stringify(lastCounts)}`,
        '',
      );
      verdicts.check(
        'NFR-PERF-03 감시 1주기(조회 계층, 커넥션 1개 순차)',
        cycleMs < TARGET.pollIntervalMs,
        `${(cycleMs / 1_000).toFixed(1)}초 / 목표 60초`,
      );

      // 목록·상세: 스케줄러를 돌려 가며
      const lastPage = Math.ceil(SEED.triggersPerScheduler / 50);
      const pick = (r: number) => ctxs[(r * 7) % ctxs.length]!;
      const cases: [string, (r: number) => Promise<unknown>][] = [
        [
          '트리거 목록 1쪽(키 정렬)',
          (r) => listTriggers(conn, pick(r), { sort: 'key', page: 1, size: 50 }),
        ],
        [
          '트리거 목록 마지막 쪽(키 정렬)',
          (r) => listTriggers(conn, pick(r), { sort: 'key', page: lastPage, size: 50 }),
        ],
        [
          '트리거 목록 1쪽(다음 실행 정렬)',
          (r) => listTriggers(conn, pick(r), { sort: 'nextFireTime', page: 1, size: 50 }),
        ],
        [
          '트리거 목록 마지막 쪽(다음 실행 정렬)',
          (r) => listTriggers(conn, pick(r), { sort: 'nextFireTime', page: lastPage, size: 50 }),
        ],
        [
          '트리거 목록 200개',
          (r) => listTriggers(conn, pick(r), { sort: 'key', page: 1, size: 200 }),
        ],
        [
          '트리거 상태 필터(PAUSED)',
          (r) => listTriggers(conn, pick(r), { state: ['PAUSED'], sort: 'key', page: 1, size: 50 }),
        ],
        [
          '트리거 그룹 필터',
          (r) =>
            listTriggers(conn, pick(r), { group: perfGroup(r), sort: 'key', page: 1, size: 50 }),
        ],
        [
          '트리거 검색(부분 일치)',
          (r) =>
            listTriggers(conn, pick(r), { q: String(4_000 + r), sort: 'key', page: 1, size: 50 }),
        ],
        ['잡 목록 1쪽', (r) => listJobs(conn, pick(r), { page: 1, size: 50 })],
        ['잡 목록 마지막 쪽', (r) => listJobs(conn, pick(r), { page: lastPage, size: 50 })],
        [
          '잡 검색(부분 일치)',
          (r) => listJobs(conn, pick(r), { q: String(4_000 + r), page: 1, size: 50 }),
        ],
        [
          '트리거 상세',
          (r) =>
            getTriggerDetail(conn, pick(r), {
              group: perfGroup(r * 13),
              name: perfTriggerName(r * 13),
            }),
        ],
        [
          '잡 상세',
          (r) =>
            getJobDetail(conn, pick(r), { group: perfGroup(r * 13), name: perfJobName(r * 13) }),
        ],
        ['노드', (r) => listNodes(conn, pick(r), { dbNow: Date.now(), checkinMultiplier: 3 })],
        [
          '실행 중',
          (r) => listExecuting(conn, pick(r), { dbNow: Date.now(), checkinMultiplier: 3 }),
        ],
      ];
      const rows: (string | number)[][] = [];
      for (const [name, run] of cases) {
        await run(REPEAT);
        const samples: number[] = [];
        let calls = 0;
        for (let r = 0; r < REPEAT; r++) {
          conn.reset();
          samples.push((await timed(() => run(r))).ms);
          calls = conn.calls;
        }
        const s = summarize(samples);
        rows.push(summaryRow(name, s, [calls]));
        verdicts.check(
          `NFR-PERF-02 ${name}(조회 계층)`,
          s.p95 <= TARGET.listP95,
          `p95 ${ms(s.p95)}ms`,
        );
      }
      report.push(
        '### 목록·상세',
        '',
        table(['조회', '횟수', 'p50', 'p95', '최대', '쿼리 왕복'], rows),
        '',
      );
    } finally {
      await conn.close();
    }
  });

  for (const layout of LAYOUTS) {
    it(`API 계층: ${layout === 'single' ? '접속 1개' : '접속 10개'}에 스케줄러 ${SEED.schedulers}개`, async () => {
      await measureApi(db, seed, layout === 'single' ? 1 : 10);
    });
  }

  it('판정: NFR-PERF 목표', () => {
    expect(verdicts.failures.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });
});

// ── API 계층 ──────────────────────────────────────────────────────

/** 대상 DB에 붙은 세션 수. 측정 프로세스의 세션은 기동 전 기준값으로 뺀다 */
async function sessionCounter(
  db: DbFixture,
): Promise<{ count(): Promise<number>; close(): Promise<void> }> {
  if (db.kind === 'oracle') {
    const user = db.user.toUpperCase();
    return {
      count: () =>
        db.oracle!.withSystemConnection(async (c) => {
          const r = await c.execute<[number]>(
            `SELECT COUNT(*) FROM v$session WHERE username = :1`,
            [user],
          );
          return Number(r.rows![0]![0]);
        }),
      close: async () => {},
    };
  }
  const conn: TestConnection = await db.connect();
  const sql =
    db.kind === 'postgres'
      ? `SELECT COUNT(*) FROM pg_stat_activity WHERE application_name = 'quartz-admin'`
      : `SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = SUBSTRING_INDEX(USER(), '@', 1)`;
  return {
    async count() {
      const r = await conn.execute<[number | string]>(sql);
      return Number(r.rows![0]![0]);
    },
    close: () => conn.close(),
  };
}

async function measureApi(db: DbFixture, seed: SeedResult, connectionCount: number): Promise<void> {
  const label = connectionCount === 1 ? '접속 1개' : `접속 ${connectionCount}개`;
  const sessions = await sessionCounter(db);
  // PostgreSQL은 제품 세션만 센다(application_name). 다른 DB는 측정 프로세스 세션을 기준값으로 뺀다
  const baseline = db.kind === 'postgres' ? 0 : await sessions.count();
  const api = await startApi({
    logFile: path.join(REPORT_DIR, `${TEST_DB}-${STAMP}-api-${connectionCount}.log`),
  });
  try {
    // 접속을 만들고 감지한 뒤 스케줄러를 나눠 등록한다
    const target = db.targetInfo();
    const perConnection = Math.ceil(seed.schedNames.length / connectionCount);
    const ids: number[] = [];
    const registerStarted = Date.now();
    for (let c = 0; c < connectionCount; c++) {
      const conn = await api.post<ConnectionDto>('/connections', {
        name: `perf-${c + 1}`,
        dbType: target.kind,
        host: target.host,
        port: target.port,
        ...(target.oracleServiceName
          ? { oracleServiceName: target.oracleServiceName }
          : { database: target.database }),
        username: target.username,
        password: target.password,
        envLabel: 'perf',
      });
      const detection = await api.post<DetectionDto>(`/connections/${conn.id}/detect`, {});
      const set = detection.tableSets[0]!;
      const mine = seed.schedNames.slice(c * perConnection, (c + 1) * perConnection);
      for (let i = 0; i < mine.length; i += 50) {
        const created = await api.post<SchedulerDto[]>(`/connections/${conn.id}/schedulers`, {
          selections: mine.slice(i, i + 50).map((schedName) => ({ prefix: set.prefix, schedName })),
        });
        ids.push(...created.map((s) => s.id));
      }
    }
    log(`${label}: 스케줄러 ${ids.length}개 등록 (${Date.now() - registerStarted}ms)`);

    // 등록하면 바로 한 번씩 감시한다. 모두 성공 스냅샷이 생길 때까지
    let firstSweepMs = Number.NaN;
    while (Date.now() - registerStarted < 120_000) {
      const d = await api.get<DashboardResponse>('/schedulers');
      if (
        d.items.length === ids.length &&
        d.items.every((i) => i.snapshot && !i.snapshot.errorCode)
      ) {
        firstSweepMs = Date.now() - registerStarted;
        break;
      }
      await sleep(500);
    }

    // 관찰: 대시보드를 2초마다 읽어(응답 시간도 잰다) 스케줄러별 감시 시각과 실패를 모은다. 세션 수도 함께 본다
    const polls = new Map<number, Map<number, SnapshotDto>>();
    const dashboardMs: number[] = [];
    let maxSessions = 0;
    const observeUntil = Date.now() + OBSERVE_SEC * 1_000;
    const observe = (async () => {
      while (Date.now() < observeUntil) {
        const { value, ms: t } = await timed(() => api.get<DashboardResponse>('/schedulers'));
        dashboardMs.push(t);
        for (const item of value.items) {
          if (!item.snapshot) continue;
          let seen = polls.get(item.id);
          if (!seen) polls.set(item.id, (seen = new Map<number, SnapshotDto>()));
          seen.set(item.snapshot.polledAt, item.snapshot);
        }
        maxSessions = Math.max(maxSessions, (await sessions.count()) - baseline);
        await sleep(2_000);
      }
    })();

    // 관찰하는 동안 목록 조회(사용자 흉내)
    const pick = (r: number) => ids[(r * 7) % ids.length]!;
    const lastPage = Math.ceil(SEED.triggersPerScheduler / 50);
    const cases: [string, (r: number) => string][] = [
      ['트리거 목록 1쪽', (r) => `/schedulers/${pick(r)}/triggers?page=1&size=50`],
      [
        '트리거 목록 마지막 쪽(다음 실행 정렬)',
        (r) => `/schedulers/${pick(r)}/triggers?sort=nextFireTime&page=${lastPage}&size=50`,
      ],
      ['트리거 검색', (r) => `/schedulers/${pick(r)}/triggers?q=${4_000 + r}&page=1&size=50`],
      ['잡 목록 1쪽', (r) => `/schedulers/${pick(r)}/jobs?page=1&size=50`],
      ['잡 목록 마지막 쪽', (r) => `/schedulers/${pick(r)}/jobs?page=${lastPage}&size=50`],
    ];
    const listRows: (string | number)[][] = [];
    const errors = new Map<string, number>();
    const record = (err: unknown) => {
      const key = err instanceof ApiError ? `${err.status} ${err.code ?? ''}`.trim() : String(err);
      errors.set(key, (errors.get(key) ?? 0) + 1);
    };
    for (const [name, url] of cases) {
      const samples: number[] = [];
      for (let r = 0; r < REPEAT; r++) {
        try {
          samples.push((await timed(() => api.get(url(r)))).ms);
        } catch (err) {
          record(err);
        }
      }
      const s = summarize(samples);
      listRows.push(summaryRow(`${name} (한 명)`, s));
      verdicts.check(
        `NFR-PERF-02 ${name}(API, ${label})`,
        s.p95 <= TARGET.listP95,
        `p95 ${ms(s.p95)}ms`,
      );
    }
    // 동시 사용자: 서로 다른 스케줄러의 트리거 목록을 한꺼번에 USERS개씩, 5번
    const burst: number[] = [];
    for (let round = 0; round < 5; round++) {
      const results = await Promise.allSettled(
        Array.from({ length: USERS }, (_, u) =>
          timed(() => api.get(`/schedulers/${pick(round * USERS + u)}/triggers?page=1&size=50`)),
        ),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') burst.push(r.value.ms);
        else record(r.reason);
      }
    }
    const b = summarize(burst);
    listRows.push(summaryRow(`트리거 목록 1쪽 (동시 ${USERS}명)`, b));
    verdicts.check(
      `NFR-PERF-02 트리거 목록 동시 ${USERS}명(API, ${label})`,
      b.p95 <= TARGET.listP95 && b.n === USERS * 5,
      `p95 ${ms(b.p95)}ms, 성공 ${b.n}/${USERS * 5}`,
    );
    // 대시보드 동시 조회
    const dashBurst: number[] = [];
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(
        Array.from({ length: USERS }, () => timed(() => api.get('/schedulers'))),
      );
      dashBurst.push(...results.map((r) => r.ms));
    }

    await observe;

    // 감시 간격: 관찰 중 본 감시 시각의 간격. 실패한 회차도 센다
    const intervals: number[] = [];
    let failed = 0;
    const failCodes = new Map<string, number>();
    let missing = 0;
    for (const id of ids) {
      const seen = [...(polls.get(id)?.values() ?? [])].sort((x, y) => x.polledAt - y.polledAt);
      if (seen.length < 2) missing++;
      for (let i = 1; i < seen.length; i++)
        intervals.push(seen[i]!.polledAt - seen[i - 1]!.polledAt);
      for (const s of seen) {
        if (s.errorCode) {
          failed++;
          failCodes.set(s.errorCode, (failCodes.get(s.errorCode) ?? 0) + 1);
        }
      }
    }
    const iv = summarize(intervals);
    const d1 = summarize(dashboardMs);
    const d20 = summarize(dashBurst);
    const maxConns = connectionCount * TARGET.connectionsPerTarget;

    report.push(
      `## 2. API 계층: ${label}에 스케줄러 ${ids.length}개`,
      '',
      `- 등록부터 모든 스케줄러의 첫 감시 성공까지: ${Number.isFinite(firstSweepMs) ? `${(firstSweepMs / 1_000).toFixed(1)}초` : '120초 안에 끝나지 않음'}`,
      `- 감시 간격(관찰 ${OBSERVE_SEC}초): ${iv.n}개, p50 ${(iv.p50 / 1_000).toFixed(2)}초, 최대 ${(iv.max / 1_000).toFixed(2)}초. 두 번 이상 감시되지 않은 스케줄러 ${missing}개`,
      `- 실패한 감시 회차: ${failed}개${failCodes.size ? ` (${[...failCodes].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`,
      `- 대상 DB 세션(제품): 최대 ${maxSessions}개 / 허용 ${maxConns}개(접속 ${connectionCount}개 × 2)`,
      `- 조회 오류: ${errors.size ? [...errors].map(([k, v]) => `${k} ${v}건`).join(', ') : '없음'}`,
      '',
      table(
        ['요청', '횟수', 'p50', 'p95', '최대'],
        [
          summaryRow('대시보드 (한 명, 관찰 중 2초마다)', d1),
          summaryRow(`대시보드 (동시 ${USERS}명)`, d20),
          ...listRows,
        ],
      ),
      '',
    );
    verdicts.check(
      `NFR-PERF-01 대시보드(API, ${label})`,
      Math.max(d1.p95, d20.p95) <= TARGET.dashboardP95,
      `p95 ${ms(d1.p95)}ms, 동시 ${ms(d20.p95)}ms`,
    );
    verdicts.check(
      `NFR-PERF-03 감시 주기(API, ${label})`,
      missing === 0 && failed === 0 && iv.max <= TARGET.pollIntervalMs + TARGET.intervalSlackMs,
      `최대 간격 ${(iv.max / 1_000).toFixed(1)}초, 실패 ${failed}회, 누락 ${missing}개`,
    );
    verdicts.check(
      `NFR-PERF-04 세션 수(${label})`,
      maxSessions <= maxConns,
      `최대 ${maxSessions}개 / ${maxConns}개`,
    );
    verdicts.check(
      `조회 오류 없음(${label})`,
      errors.size === 0,
      errors.size ? [...errors.keys()].join(', ') : '없음',
    );

    // 화면을 직접 볼 때: 접속 정보를 파일에 남기고, 멈춤 파일이 생기거나 시간이 지날 때까지 API를 띄워 둔다
    if (HOLD_MIN > 0 && connectionCount === 1) {
      const info = path.join(REPORT_DIR, 'hold.json');
      const stop = path.join(REPORT_DIR, 'hold.stop');
      rmSync(stop, { force: true });
      writeFileSync(info, JSON.stringify(api.holdInfo(), null, 2));
      log(`API를 ${HOLD_MIN}분 동안 띄워 둡니다. 접속 정보 ${info}, 끝내려면 ${stop}을 만드세요`);
      const until = Date.now() + HOLD_MIN * 60_000;
      while (Date.now() < until && !existsSync(stop)) await sleep(1_000);
      rmSync(info, { force: true });
      rmSync(stop, { force: true });
    }
  } finally {
    await api.stop();
    await sessions.close();
  }
}
