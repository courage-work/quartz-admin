import { triggerListQuerySchema, type NodesResponse, type Page, type TriggerDto } from '@qa/shared';
import {
  TargetPoolManager,
  type BindValue,
  type DriverAdapter,
  type QuartzDetection,
  type Row,
  type TargetConn,
} from '@qa/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp } from '../auth/test-support.js';
import { QUARTZ_DETECTOR, type QuartzDetector } from '../targets/targets.service.js';
import { describeJobData } from './job-data.js';

describe('describeJobData (FR-VIEW-08)', () => {
  it('properties 형식은 키 순서로 정렬한 키-값을 돌려준다', () => {
    const bytes = Buffer.from(
      '#Quartz\n#Fri Nov 06\nretry=3\nowner=ops\\u00e9\nurl=http\\://x\n',
      'latin1',
    );
    expect(describeJobData(bytes)).toEqual({
      format: 'properties',
      entries: [
        { key: 'owner', value: 'opsé' },
        { key: 'retry', value: '3' },
        { key: 'url', value: 'http://x' },
      ],
    });
  });

  it('Java 직렬화(0xACED)와 이진 데이터는 표시하지 않는다', () => {
    expect(describeJobData(Buffer.from([0xac, 0xed, 0x00, 0x05, 0x73]))).toEqual({
      format: 'java-serialized',
      bytes: 5,
    });
    expect(describeJobData(Buffer.from([0x01, 0x02, 0x03]))).toEqual({
      format: 'unreadable',
      bytes: 3,
    });
    expect(describeJobData(null)).toEqual({ format: 'empty' });
  });
});

describe('triggerListQuerySchema', () => {
  it('반복 값과 쉼표 값을 모두 배열로 받는다', () => {
    expect(
      triggerListQuerySchema.parse({ state: ['WAITING', 'PAUSED,ERROR'], type: 'CRON' }),
    ).toMatchObject({
      state: ['WAITING', 'PAUSED', 'ERROR'],
      type: ['CRON'],
      sort: 'key',
      page: 1,
      size: 50,
    });
    expect(triggerListQuerySchema.safeParse({ state: 'RUNNING' }).success).toBe(false);
    expect(triggerListQuerySchema.safeParse({ size: '500' }).success).toBe(false);
    expect(triggerListQuerySchema.parse({ q: '  ' }).q).toBeUndefined();
  });
});

// ── API ─────────────────────────────────────────────────

const features = {
  simpropTriggers: false,
  triggerPriority: true,
  firedPriority: true,
  firedSchedTime: true,
  jobNonconcurrent: true,
  jobUpdateData: true,
  cronTimeZone: true,
};

const DB_NOW = 1_762_400_000_000;

/** SQL 모양에 따라 정해 둔 행을 돌려주는 가짜 Oracle 커넥션 */
class FakeTarget {
  readonly sql: { sql: string; binds: readonly BindValue[] }[] = [];
  readonly adapter: DriverAdapter = {
    kind: 'oracle',
    connect: () => {
      const conn: TargetConn = {
        kind: 'oracle',
        inTransaction: false,
        query: <R extends Row = Row>(sql: string, binds: readonly BindValue[] = []) => {
          this.sql.push({ sql, binds });
          return Promise.resolve(this.answer(sql) as R[]);
        },
        execute: () => Promise.reject(new Error('조회 API는 쓰지 않는다')),
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      return Promise.resolve(conn);
    },
  };

  private answer(sql: string): Row[] {
    if (sql.includes('SYSTIMESTAMP')) return [{ NOW_MS: DB_NOW }];
    if (sql.includes('COUNT(*) AS "CNT"')) return [{ CNT: 1 }];
    if (sql.includes('SCHEDULER_STATE')) {
      return [
        { N: 'node-1', L: DB_NOW - 1_000, I: 7_500 },
        { N: 'node-2', L: DB_NOW - 600_000, I: 7_500 },
      ];
    }
    if (sql.includes('"QRTZ_TRIGGERS" t LEFT JOIN')) {
      return [
        {
          G: 'g/1',
          N: 'a%b',
          JG: 'jobs',
          JN: 'job',
          D: null,
          TY: 'CRON',
          ST: 'WAITING',
          NFT: DB_NOW + 1_000,
          PFT: -1,
          STT: DB_NOW,
          ET: 0,
          PR: 5,
          MI: 0,
          CAL: null,
          CE: '0 * * * * ?',
          TZ: 'Asia/Seoul',
          RC: null,
          RI: null,
          TT: null,
        },
      ];
    }
    return [];
  }
}

describe('스케줄러 조회 API (TRD §8.1)', () => {
  let t: TestApp;
  let fake: FakeTarget;
  let cookie: string;
  let schedulerId: number;

  beforeEach(async () => {
    fake = new FakeTarget();
    const detection: QuartzDetection = {
      schema: 'QUARTZ',
      dbNow: DB_NOW,
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
              triggerCount: 1,
              nodeCount: 2,
              activeNodeCount: 1,
              expectedNodeCount: 1,
            },
          ],
        },
      ],
      unusable: [],
    };
    const detector: QuartzDetector = () => Promise.resolve(structuredClone(detection));
    t = await createTestApp({
      overrides: [
        { provide: QUARTZ_DETECTOR, useValue: detector },
        { provide: TargetPoolManager, useValue: new TargetPoolManager([fake.adapter]) },
      ],
    });
    cookie = await t.login(ADMIN.username, ADMIN.password);
    const conn = await t
      .send(
        'post',
        '/connections',
        {
          name: 'c',
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
    const reg = await t
      .send(
        'post',
        `/connections/${(conn.body as { id: number }).id}/schedulers`,
        { selections: [{ prefix: 'QRTZ_', schedName: 'S' }] },
        cookie,
      )
      .expect(201);
    schedulerId = (reg.body as { id: number }[])[0]!.id;
  });

  afterEach(async () => {
    await t.close();
  });

  it('감지한 스키마로 테이블을 가리키고, 응답에 dbNow와 노드 활성 판정을 넣는다', async () => {
    const res = await t.get(`/schedulers/${schedulerId}/nodes`, cookie).expect(200);
    expect(res.body).toEqual({
      dbNow: DB_NOW,
      checkinMultiplier: 3,
      nodes: [
        {
          instanceName: 'node-1',
          lastCheckinTime: DB_NOW - 1_000,
          checkinInterval: 7_500,
          active: true,
          sinceCheckinMs: 1_000,
        },
        {
          instanceName: 'node-2',
          lastCheckinTime: DB_NOW - 600_000,
          checkinInterval: 7_500,
          active: false,
          sinceCheckinMs: 600_000,
        },
      ],
    } satisfies NodesResponse);
    expect(fake.sql.some((s) => s.sql.includes('"QUARTZ"."QRTZ_SCHEDULER_STATE"'))).toBe(true);
  });

  it('트리거 목록은 필터를 바인드로 넘기고 페이지 정보와 함께 돌려준다', async () => {
    const res = await t
      .get(
        `/schedulers/${schedulerId}/triggers?state=WAITING&state=PAUSED&group=${encodeURIComponent('g/1')}&q=a%25b&page=2&size=10`,
        cookie,
      )
      .expect(200);
    const page = res.body as Page<TriggerDto>;
    expect(page).toMatchObject({ dbNow: DB_NOW, total: 1, page: 2, size: 10 });
    expect(page.items[0]).toMatchObject({
      group: 'g/1',
      name: 'a%b',
      prevFireTime: null,
      endTime: null,
      cron: { expression: '0 * * * * ?', timeZone: 'Asia/Seoul' },
    });
    const listCall = fake.sql.find((s) => s.sql.includes('LEFT JOIN'))!;
    expect(listCall.binds).toEqual([
      'S',
      'WAITING',
      'PAUSED',
      'g/1',
      '%a!%b%',
      '%a!%b%',
      '%a!%b%',
      10,
      10,
    ]);
  });

  it('잘못된 쿼리는 400, 없는 스케줄러와 없는 잡은 404', async () => {
    await t.get(`/schedulers/${schedulerId}/triggers?state=RUNNING`, cookie).expect(400);
    await t.get(`/schedulers/${schedulerId}/jobs?size=1000`, cookie).expect(400);
    await t.get(`/schedulers/${schedulerId}/jobs/detail?group=jobs`, cookie).expect(400);
    await t.get('/schedulers/999/nodes', cookie).expect(404);
    const missing = await t
      .get(`/schedulers/${schedulerId}/jobs/detail?group=jobs&name=nope`, cookie)
      .expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('조회는 감사 로그를 남기지 않는다', async () => {
    const before = (await t.get('/audit-logs?limit=200', cookie)).body as { items: unknown[] };
    await t.get(`/schedulers/${schedulerId}/executing`, cookie).expect(200);
    await t.get(`/schedulers/${schedulerId}/paused-groups`, cookie).expect(200);
    const after = (await t.get('/audit-logs?limit=200', cookie)).body as { items: unknown[] };
    expect(after.items.length).toBe(before.items.length);
  });
});
