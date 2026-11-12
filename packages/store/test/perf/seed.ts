import type { DbFixture, TestConnection } from '../support/index.js';
import { quartzTableName, type QuartzTable } from '../support/index.js';

/**
 * 성능·규모 검증(B-31)용 합성 데이터. PRD §7.2의 규모 가정(스케줄러 100개 × 트리거 10,000개)을 Quartz 테이블 한 벌에 넣는다.
 *
 * - 첫 스케줄러의 행을 테스트 프로세스에서 만들어 넣고, 나머지는 `INSERT ... SELECT`로 SCHED_NAME만 바꿔 복사한다.
 *   DB마다 다른 행 생성 문법(generate_series, CONNECT BY, 재귀 CTE)을 쓰지 않아도 되고, 100만 행도 몇 분 안에 들어간다
 * - Quartz 노드는 띄우지 않는다. 다음 실행 시각은 미래(1시간~1일 뒤)로 두어 측정 중에 저절로 연체가 되지 않게 하고,
 *   노드 체크인은 {@link startHeartbeat}가 갱신한다
 * - 감시 쿼리가 실제로 결과를 돌려주도록 상태를 섞는다(스케줄러마다 ERROR 50, BLOCKED 100, PAUSED 500, 연체 100, 실행 중 20)
 */
export interface PerfSeedOptions {
  schedulers: number;
  triggersPerScheduler: number;
  /** 스케줄러마다 노드 수 */
  nodes: number;
}

export const DEFAULT_SEED: PerfSeedOptions = {
  schedulers: 100,
  triggersPerScheduler: 10_000,
  nodes: 2,
};

/** 트리거 그룹 수. 그룹마다 `triggersPerScheduler / GROUPS`개 */
export const GROUPS = 50;
export const CHECKIN_INTERVAL_MS = 7_500;
const EXECUTING_PER_SCHEDULER = 20;

export function perfSchedName(index: number): string {
  return `PERF_${String(index + 1).padStart(3, '0')}`;
}

export function perfTriggerName(i: number): string {
  return `trg-${String(i).padStart(5, '0')}`;
}

export function perfJobName(i: number): string {
  return `job-${String(i).padStart(5, '0')}`;
}

export function perfGroup(i: number): string {
  return `grp-${String(i % GROUPS).padStart(2, '0')}`;
}

export type PerfState = 'WAITING' | 'PAUSED' | 'ERROR' | 'BLOCKED';

/** 트리거 i의 상태와 연체 여부. 상태 비율은 스케줄러마다 같다 */
export function perfTriggerKind(i: number): { state: PerfState; overdue: boolean; cron: boolean } {
  const cron = i % 5 < 3;
  if (i % 200 === 0) return { state: 'ERROR', overdue: false, cron };
  if (i % 100 === 1) return { state: 'BLOCKED', overdue: false, cron };
  if (i % 20 === 2) return { state: 'PAUSED', overdue: false, cron };
  if (i % 100 === 3) return { state: 'WAITING', overdue: true, cron };
  return { state: 'WAITING', overdue: false, cron };
}

/** 스케줄러 하나에 들어가는 상태별 트리거 수 */
export function expectedCounts(triggers: number): Record<string, number> & { overdue: number } {
  const counts: Record<string, number> = {};
  let overdue = 0;
  for (let i = 0; i < triggers; i++) {
    const k = perfTriggerKind(i);
    counts[k.state] = (counts[k.state] ?? 0) + 1;
    if (k.overdue) overdue++;
  }
  return Object.assign(counts, { overdue });
}

/** 각 테이블에 넣는 컬럼. 첫 컬럼은 SCHED_NAME이다(복사할 때 바꾼다) */
const COLUMNS: Partial<Record<QuartzTable, readonly string[]>> = {
  JOB_DETAILS: [
    'SCHED_NAME',
    'JOB_NAME',
    'JOB_GROUP',
    'DESCRIPTION',
    'JOB_CLASS_NAME',
    'IS_DURABLE',
    'IS_NONCONCURRENT',
    'IS_UPDATE_DATA',
    'REQUESTS_RECOVERY',
  ],
  TRIGGERS: [
    'SCHED_NAME',
    'TRIGGER_NAME',
    'TRIGGER_GROUP',
    'JOB_NAME',
    'JOB_GROUP',
    'DESCRIPTION',
    'NEXT_FIRE_TIME',
    'PREV_FIRE_TIME',
    'PRIORITY',
    'TRIGGER_STATE',
    'TRIGGER_TYPE',
    'START_TIME',
    'END_TIME',
    'MISFIRE_INSTR',
  ],
  CRON_TRIGGERS: ['SCHED_NAME', 'TRIGGER_NAME', 'TRIGGER_GROUP', 'CRON_EXPRESSION', 'TIME_ZONE_ID'],
  SIMPLE_TRIGGERS: [
    'SCHED_NAME',
    'TRIGGER_NAME',
    'TRIGGER_GROUP',
    'REPEAT_COUNT',
    'REPEAT_INTERVAL',
    'TIMES_TRIGGERED',
  ],
  SCHEDULER_STATE: ['SCHED_NAME', 'INSTANCE_NAME', 'LAST_CHECKIN_TIME', 'CHECKIN_INTERVAL'],
  FIRED_TRIGGERS: [
    'SCHED_NAME',
    'ENTRY_ID',
    'TRIGGER_NAME',
    'TRIGGER_GROUP',
    'INSTANCE_NAME',
    'FIRED_TIME',
    'SCHED_TIME',
    'PRIORITY',
    'STATE',
    'JOB_NAME',
    'JOB_GROUP',
    'IS_NONCONCURRENT',
    'REQUESTS_RECOVERY',
  ],
  LOCKS: ['SCHED_NAME', 'LOCK_NAME'],
};

/** 부모 테이블이 앞이다(FK) */
const TABLE_ORDER: readonly QuartzTable[] = [
  'JOB_DETAILS',
  'TRIGGERS',
  'CRON_TRIGGERS',
  'SIMPLE_TRIGGERS',
  'SCHEDULER_STATE',
  'FIRED_TRIGGERS',
  'LOCKS',
];

function insertSql(db: DbFixture, table: QuartzTable): string {
  const cols = COLUMNS[table]!;
  return (
    `INSERT INTO ${quartzTableName(table, { db: db.kind })} (${cols.join(', ')}) ` +
    `VALUES (${cols.map((_, i) => `:${i + 1}`).join(', ')})`
  );
}

/** 첫 스케줄러의 행. 불리언은 PostgreSQL BOOL, 그 밖은 VARCHAR(1) '1'/'0'이다 */
function firstSchedulerRows(
  db: DbFixture,
  schedName: string,
  opts: PerfSeedOptions,
  now: number,
): Map<QuartzTable, unknown[][]> {
  const bool = (v: boolean) => (db.kind === 'postgres' ? v : v ? '1' : '0');
  const n = opts.triggersPerScheduler;
  const jobs: unknown[][] = [];
  const triggers: unknown[][] = [];
  const crons: unknown[][] = [];
  const simples: unknown[][] = [];
  for (let i = 0; i < n; i++) {
    const group = perfGroup(i);
    const job = perfJobName(i);
    const trigger = perfTriggerName(i);
    const kind = perfTriggerKind(i);
    jobs.push([
      schedName,
      job,
      group,
      `합성 잡 ${i}`,
      'com.example.perf.SyntheticJob',
      bool(false),
      bool(i % 3 === 0),
      bool(false),
      bool(false),
    ]);
    // 정상 트리거는 1시간 뒤부터 하루 안에 고르게 흩어 둔다
    const next = kind.overdue ? now - 3_600_000 : now + 3_600_000 + ((i * 7_919) % 82_800_000);
    triggers.push([
      schedName,
      trigger,
      group,
      job,
      group,
      `합성 트리거 ${i}`,
      next,
      now - 3_600_000,
      5,
      kind.state,
      kind.cron ? 'CRON' : 'SIMPLE',
      now - 86_400_000,
      0,
      0,
    ]);
    if (kind.cron) {
      crons.push([schedName, trigger, group, `0 ${i % 60} * * * ?`, 'Asia/Seoul']);
    } else {
      simples.push([schedName, trigger, group, -1, 60_000 + (i % 10) * 1_000, i]);
    }
  }
  const nodes: unknown[][] = [];
  for (let k = 0; k < opts.nodes; k++) {
    nodes.push([schedName, `perf-node-${k + 1}`, now, CHECKIN_INTERVAL_MS]);
  }
  const fired: unknown[][] = [];
  for (let k = 0; k < EXECUTING_PER_SCHEDULER; k++) {
    const i = k * 7 + 5; // WAITING이고 연체가 아닌 트리거
    fired.push([
      schedName,
      `perf-node-1-${k}`,
      perfTriggerName(i),
      perfGroup(i),
      'perf-node-1',
      now - 1_000 * (k + 1),
      now - 1_000 * (k + 1),
      5,
      'EXECUTING',
      perfJobName(i),
      perfGroup(i),
      bool(false),
      bool(false),
    ]);
  }
  return new Map<QuartzTable, unknown[][]>([
    ['JOB_DETAILS', jobs],
    ['TRIGGERS', triggers],
    ['CRON_TRIGGERS', crons],
    ['SIMPLE_TRIGGERS', simples],
    ['SCHEDULER_STATE', nodes],
    ['FIRED_TRIGGERS', fired],
    [
      'LOCKS',
      [
        [schedName, 'STATE_ACCESS'],
        [schedName, 'TRIGGER_ACCESS'],
      ],
    ],
  ]);
}

/** 첫 스케줄러의 행을 SCHED_NAME만 바꿔 복사한다. 이름은 우리가 만든 값이라 리터럴로 넣는다 */
function copySql(db: DbFixture, table: QuartzTable, from: string, to: string): string {
  const cols = COLUMNS[table]!;
  const t = quartzTableName(table, { db: db.kind });
  return (
    `INSERT INTO ${t} (${cols.join(', ')}) SELECT '${to}', ${cols.slice(1).join(', ')} ` +
    `FROM ${t} WHERE SCHED_NAME = '${from}'`
  );
}

export interface SeedResult {
  schedNames: string[];
  seededAt: number;
  elapsedMs: number;
}

/**
 * 빈 Quartz 스키마(`initQuartzSchema`)에 합성 데이터를 넣고 통계를 모은다.
 * 운영 DB에는 옵티마이저 통계가 있으므로, 측정이 통계 없는 실행 계획에 좌우되지 않게 한다
 */
export async function seedPerfData(
  db: DbFixture,
  opts: PerfSeedOptions = DEFAULT_SEED,
  log: (msg: string) => void = () => {},
): Promise<SeedResult> {
  const started = Date.now();
  const schedNames = Array.from({ length: opts.schedulers }, (_, i) => perfSchedName(i));
  const first = schedNames[0]!;
  await db.withConnection(async (conn) => {
    const rows = firstSchedulerRows(db, first, opts, started);
    for (const table of TABLE_ORDER) {
      const data = rows.get(table)!;
      if (data.length > 0) await conn.executeMany(insertSql(db, table), data);
    }
    await conn.commit();
    log(`${first}: ${opts.triggersPerScheduler}개 트리거 (${Date.now() - started}ms)`);

    for (const [index, name] of schedNames.entries()) {
      if (index === 0) continue;
      for (const table of TABLE_ORDER) await conn.execute(copySql(db, table, first, name));
      await conn.commit();
      if ((index + 1) % 10 === 0)
        log(`${index + 1}/${opts.schedulers} (${Date.now() - started}ms)`);
    }
    await gatherStats(db, conn);
  });
  log(`통계 수집 완료 (${Date.now() - started}ms)`);
  return { schedNames, seededAt: started, elapsedMs: Date.now() - started };
}

async function gatherStats(db: DbFixture, conn: TestConnection): Promise<void> {
  const tables = TABLE_ORDER.map((t) => quartzTableName(t, { db: db.kind }));
  if (db.kind === 'oracle') {
    await conn.execute(`BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(ownname => USER); END;`);
  } else if (db.kind === 'postgres') {
    for (const t of tables) await conn.execute(`ANALYZE ${t}`);
    await conn.commit();
  } else {
    await conn.execute(`ANALYZE TABLE ${tables.join(', ')}`);
    await conn.commit();
  }
}

/**
 * 합성 노드의 체크인을 주기마다 갱신한다(실제 노드 대신). 노드가 살아 있는 것으로 보여야 대시보드 상태가 정상 범위에 머문다
 */
export async function startHeartbeat(
  db: DbFixture,
  intervalMs = CHECKIN_INTERVAL_MS,
): Promise<{ stop(): Promise<void> }> {
  const conn = await db.connect();
  const table = quartzTableName('SCHEDULER_STATE', { db: db.kind });
  let pending: Promise<void> = Promise.resolve();
  const beat = async () => {
    await conn.execute(`UPDATE ${table} SET LAST_CHECKIN_TIME = :1 WHERE SCHED_NAME LIKE 'PERF%'`, [
      Date.now(),
    ]);
    await conn.commit();
  };
  await beat();
  const timer = setInterval(() => {
    pending = pending.then(beat).catch(() => {});
  }, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await pending;
      await conn.close();
    },
  };
}
