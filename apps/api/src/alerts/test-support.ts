/**
 * 알림 API 테스트의 공통 준비: 감시 쿼리에 답하는 가짜 대상 DB, 테스트 앱, 스케줄러 등록 (B-24, B-25)
 */
import type {
  AlertRulesResponse,
  QuartzDetection,
  SchedulerAlertsResponse,
  SchedulerDto,
} from '@qa/shared';
import {
  TargetError,
  TargetPoolManager,
  type BindValue,
  type DriverAdapter,
  type Row,
  type TargetConn,
} from '@qa/store';
import type Database from 'better-sqlite3';
import { ADMIN, createTestApp, type TestApp } from '../auth/test-support.js';
import type { AppConfig } from '../config/env.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { MonitorService } from '../monitor/monitor.service.js';
import { QUARTZ_DETECTOR, type QuartzDetector } from '../targets/targets.service.js';
import { NotificationWorker } from './notification-worker.js';

export const MIN = 60_000;

export const detection: QuartzDetection = {
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
      features: {
        simpropTriggers: false,
        triggerPriority: true,
        firedPriority: true,
        firedSchedTime: true,
        jobNonconcurrent: true,
        jobUpdateData: true,
        cronTimeZone: true,
      },
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

export interface FakeTrigger {
  group: string;
  name: string;
}

/** 감시 쿼리(collectMonitorData)에 답하는 가짜 대상 DB. 테스트가 상태를 바꿔 가며 감시를 한 번씩 돌린다 */
export class FakeTarget {
  now = () => 0;
  failing: TargetError | null = null;
  /** 노드별 마지막 체크인이 지금보다 얼마나 이전인지(ms). 체크인 간격 7.5초 × 3배를 넘으면 비활성 */
  nodes: Record<string, number> = { 'node-1': 1_000, 'node-2': 1_000 };
  overdue: (FakeTrigger & { lateMs: number })[] = [];
  errors: FakeTrigger[] = [];
  blocked: FakeTrigger[] = [];

  readonly adapter: DriverAdapter = {
    kind: 'oracle',
    connect: () => {
      if (this.failing) return Promise.reject(this.failing);
      const conn: TargetConn = {
        kind: 'oracle',
        inTransaction: false,
        query: <R extends Row = Row>(sql: string, _binds: readonly BindValue[] = []) =>
          this.failing ? Promise.reject(this.failing) : Promise.resolve(this.answer(sql) as R[]),
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
    if (sql.includes('GROUP BY TRIGGER_STATE')) return [{ ST: 'WAITING', CNT: 3 }];
    if (sql.includes('SCHEDULER_STATE')) {
      return Object.entries(this.nodes).map(([N, ago]) => ({ N, L: now - ago, I: 7_500 }));
    }
    if (sql.includes('NEXT_FIRE_TIME <') && sql.includes('COUNT(*)'))
      return [{ CNT: this.overdue.length }];
    if (sql.includes('NEXT_FIRE_TIME AS')) {
      return this.overdue.map((t) => ({ G: t.group, N: t.name, NFT: now - t.lateMs }));
    }
    if (sql.includes('TRIGGER_STATE IN') && sql.includes('TRIGGER_GROUP AS')) {
      return [
        ...this.errors.map((t) => ({ G: t.group, N: t.name, ST: 'ERROR' })),
        ...this.blocked.map((t) => ({ G: t.group, N: t.name, ST: 'BLOCKED' })),
      ];
    }
    if (sql.includes('FIRED_TRIGGERS')) return [{ CNT: 0 }];
    return [];
  }
}

export interface StartOptions {
  dataDir?: string;
  /** 재시작: 같은 데이터 디렉터리와 같은 암호화 키(이 앱의 설정)로 다시 띄운다 */
  restartOf?: TestApp;
  config?: Partial<AppConfig>;
}

export interface AlertsApp {
  app: TestApp;
  cookie: string;
  /** 시계를 크게 움직였으면 다시 로그인한 세션 쿠키 */
  session: () => Promise<string>;
  /** 발송 워커 한 회차 */
  tick: () => ReturnType<NotificationWorker['tick']>;
  sqlite: Database.Database;
  poll: (id: number) => ReturnType<MonitorService['poll']>;
  alerts: (id: number) => Promise<SchedulerAlertsResponse>;
  rules: (id: number) => Promise<AlertRulesResponse['rules']>;
  events: () => string[];
}

export async function startAlertsApp(
  fake: FakeTarget,
  options: StartOptions = {},
): Promise<AlertsApp> {
  const { dataDir, restartOf } = options;
  const detector: QuartzDetector = () => Promise.resolve(structuredClone(detection));
  const app = await createTestApp({
    ...(dataDir ? { dataDir } : {}),
    config: {
      ...options.config,
      ...(restartOf ? { encryption: restartOf.config.encryption } : {}),
    },
    overrides: [
      { provide: QUARTZ_DETECTOR, useValue: detector },
      { provide: TargetPoolManager, useValue: new TargetPoolManager([fake.adapter]) },
    ],
  });
  fake.now = () => app.clock.now;
  let cookie = await app.login(ADMIN.username, ADMIN.password);
  // 시계를 크게 움직이면 세션이 만료되므로 조회 전에 필요하면 다시 로그인한다
  let loggedInAt = app.clock.now;
  const session = async () => {
    if (app.clock.now - loggedInAt > 10 * MIN) {
      cookie = await app.login(ADMIN.username, ADMIN.password);
      loggedInAt = app.clock.now;
    }
    return cookie;
  };
  const sqlite = app.app.get(MetaDbService).sqlite;
  const monitor = app.app.get(MonitorService);
  const worker = app.app.get(NotificationWorker);
  return {
    app,
    cookie,
    session,
    tick: () => worker.tick(),
    sqlite,
    poll: (id: number) => monitor.poll(id),
    alerts: async (id: number) =>
      (await app.get(`/schedulers/${id}/alerts`, await session()).expect(200))
        .body as SchedulerAlertsResponse,
    rules: async (id: number) =>
      (
        (await app.get(`/schedulers/${id}/alert-rules`, await session()).expect(200))
          .body as AlertRulesResponse
      ).rules,
    /** 발송 큐에 들어간 (알림 타입, 이벤트) 순서 */
    events: () =>
      (
        sqlite
          .prepare(
            'SELECT a.type AS type, n.event AS event FROM notifications n JOIN alerts a ON a.id = n.alert_id ORDER BY n.id',
          )
          .all() as { type: string; event: string }[]
      ).map((r) => `${r.type}:${r.event}`),
  };
}

export async function addScheduler(app: TestApp, cookie: string): Promise<SchedulerDto> {
  const conn = await app
    .send(
      'post',
      '/connections',
      {
        name: 'db',
        dbType: 'oracle',
        host: 'db',
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
