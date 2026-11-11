import type {
  ConnectionDto,
  ConnectionTestResult,
  DeleteImpactDto,
  DetectionDto,
  QuartzDetection,
  SchedulerDto,
} from '@qa/shared';
import {
  TargetError,
  TargetPoolManager,
  type DriverAdapter,
  type TargetConn,
  type TargetConnectInfo,
} from '@qa/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp } from '../auth/test-support.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { QUARTZ_DETECTOR, type QuartzDetector } from '../targets/targets.service.js';

const PASSWORD = 'Target-Secret-9';

const features = {
  simpropTriggers: true,
  triggerPriority: true,
  firedPriority: true,
  firedSchedTime: true,
  jobNonconcurrent: true,
  jobUpdateData: true,
  cronTimeZone: true,
};

const tableNames = (prefix: string) =>
  Object.fromEntries(
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
    ].map((t) => [t, `${prefix}${t}`]),
  );

function detection(overrides: Partial<QuartzDetection> = {}): QuartzDetection {
  return {
    schema: 'QUARTZ',
    dbNow: 1_762_400_000_000,
    tableSets: [
      {
        prefix: 'QRTZ_',
        tableNames: tableNames('QRTZ_'),
        features,
        boolFormat: '10',
        boolFormatSource: 'values',
        writeCapable: true,
        missingPrivileges: [],
        warnings: [],
        schedulers: [
          {
            schedName: 'Billing',
            jobCount: 3,
            triggerCount: 4,
            nodeCount: 2,
            activeNodeCount: 2,
            expectedNodeCount: 2,
          },
          {
            schedName: 'Reports',
            jobCount: 1,
            triggerCount: 1,
            nodeCount: 1,
            activeNodeCount: 1,
            expectedNodeCount: 1,
          },
        ],
      },
    ],
    unusable: [{ prefix: 'OLD_', reason: 'MISSING_TABLES', tables: ['LOCKS'] }],
    ...overrides,
  };
}

/** 대상 DB 없이 감지 결과와 실패를 정해 두는 가짜 */
class FakeTarget {
  result: QuartzDetection = detection();
  error: TargetError | undefined;
  readonly connected: TargetConnectInfo[] = [];
  readonly schemas: (string | undefined)[] = [];

  readonly adapter: DriverAdapter = {
    kind: 'oracle',
    connect: (info) => {
      this.connected.push(info);
      const conn: TargetConn = {
        kind: 'oracle',
        inTransaction: false,
        query: () => Promise.resolve([]),
        execute: () => Promise.resolve(0),
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      return Promise.resolve(conn);
    },
  };

  readonly detector: QuartzDetector = (_conn, _dialect, options) => {
    this.schemas.push(options?.schema);
    return this.error ? Promise.reject(this.error) : Promise.resolve(structuredClone(this.result));
  };
}

const oracleInput = {
  name: '정산 운영',
  dbType: 'oracle',
  host: 'db-prod.corp.example',
  port: 1521,
  oracleServiceName: 'ORCLPDB1',
  oracleSid: '',
  database: '',
  schemaName: 'QUARTZ',
  username: 'quartz_app',
  password: PASSWORD,
  envLabel: 'Prod',
  tags: ['정산', '정산', '배치'],
};

let t: TestApp;
let fake: FakeTarget;
let cookie: string;

beforeEach(async () => {
  fake = new FakeTarget();
  t = await createTestApp({
    overrides: [
      { provide: QUARTZ_DETECTOR, useValue: fake.detector },
      { provide: TargetPoolManager, useValue: new TargetPoolManager([fake.adapter]) },
    ],
  });
  cookie = await t.login(ADMIN.username, ADMIN.password);
});

afterEach(async () => {
  await t.close();
});

async function createConnection(body: object = oracleInput): Promise<ConnectionDto> {
  const res = await t.send('post', '/connections', body, cookie).expect(201);
  return res.body as ConnectionDto;
}

function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

/** 응답이나 저장 값 어디에도 비밀번호 원문이 없어야 한다 */
function expectNoPassword(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toMatch(/"password(Enc)?"\s*:/);
}

describe('접속 등록·조회 (FR-CON-01, 06)', () => {
  it('등록한 접속을 비밀번호 없이 돌려주고, DB에는 암호문으로만 저장한다', async () => {
    const created = await createConnection();
    expect(created).toMatchObject({
      name: '정산 운영',
      dbType: 'oracle',
      oracleServiceName: 'ORCLPDB1',
      oracleSid: null,
      database: null,
      envLabel: 'prod',
      tags: ['정산', '배치'],
      readOnly: false,
      writeCapable: null,
      schedulerCount: 0,
    });
    expectNoPassword(created);

    const list = await t.get('/connections', cookie).expect(200);
    expectNoPassword(list.body);
    expect((list.body as ConnectionDto[]).map((c) => c.id)).toEqual([created.id]);
    expectNoPassword((await t.get(`/connections/${created.id}`, cookie).expect(200)).body);

    const row = t.app
      .get(MetaDbService)
      .sqlite.prepare('SELECT password_enc FROM connections WHERE id = ?')
      .get(created.id) as { password_enc: string };
    expect(row.password_enc).toMatch(/^v1:/);
    expect(row.password_enc).not.toContain(PASSWORD);
  });

  it('DB 종류별 필수 입력과 지원 범위를 검사한다', async () => {
    const res = await t
      .send('post', '/connections', { ...oracleInput, oracleServiceName: '' }, cookie)
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(res.body)).toContain('서비스 이름과 SID 중 하나만');

    const both = await t
      .send('post', '/connections', { ...oracleInput, oracleSid: 'XE' }, cookie)
      .expect(400);
    expect(JSON.stringify(both.body)).toContain('서비스 이름과 SID 중 하나만');

    const mysql = await t
      .send('post', '/connections', { ...oracleInput, dbType: 'mysql', database: 'q' }, cookie)
      .expect(400);
    expect(JSON.stringify(mysql.body)).toContain('아직 지원하지 않는 DB 종류');

    // PostgreSQL은 DB 이름이 필요하다 (B-27)
    const pgNoDb = await t
      .send('post', '/connections', { ...oracleInput, dbType: 'postgresql', port: 5432 }, cookie)
      .expect(400);
    expect(JSON.stringify(pgNoDb.body)).toContain('DB 이름을 입력하세요');

    // 오류 응답에도 입력값(비밀번호)을 넣지 않는다
    expectNoPassword(res.body);
  });

  it('같은 이름의 접속은 만들 수 없다', async () => {
    await createConnection();
    const res = await t.send('post', '/connections', oracleInput, cookie).expect(409);
    expect(res.body).toMatchObject({ code: 'CONNECTION_NAME_TAKEN' });
  });

  it('로그인하지 않으면 접근할 수 없다', async () => {
    await t.get('/connections').expect(401);
  });
});

describe('접속 수정 (FR-CON-05)', () => {
  it('비밀번호를 비워 두면 기존 값을 유지하고, 입력하면 바꾼다', async () => {
    const created = await createConnection();
    const withoutPassword = omit(oracleInput, 'password');

    await t
      .send(
        'put',
        `/connections/${created.id}`,
        { ...withoutPassword, host: 'db2.corp.example', password: '' },
        cookie,
      )
      .expect(200);
    await t.send('post', `/connections/${created.id}/detect`, undefined, cookie).expect(200);
    expect(fake.connected.at(-1)).toMatchObject({ host: 'db2.corp.example', password: PASSWORD });

    const res = await t
      .send(
        'put',
        `/connections/${created.id}`,
        { ...withoutPassword, password: 'New-Secret-1' },
        cookie,
      )
      .expect(200);
    expectNoPassword(res.body);
    await t.send('post', `/connections/${created.id}/detect`, undefined, cookie).expect(200);
    expect(fake.connected.at(-1)).toMatchObject({ password: 'New-Secret-1' });
  });

  it('대상을 바꾸면 쓰기 가능 여부를 다시 감지할 때까지 비운다', async () => {
    const created = await createConnection();
    await t.send('post', `/connections/${created.id}/detect`, undefined, cookie).expect(200);
    expect((await t.get(`/connections/${created.id}`, cookie)).body).toMatchObject({
      writeCapable: true,
    });

    // 이름과 태그만 바꾸면 그대로 둔다
    const rest = omit(oracleInput, 'password');
    await t.send('put', `/connections/${created.id}`, { ...rest, tags: ['x'] }, cookie).expect(200);
    expect((await t.get(`/connections/${created.id}`, cookie)).body).toMatchObject({
      writeCapable: true,
    });

    await t
      .send('put', `/connections/${created.id}`, { ...rest, username: 'other' }, cookie)
      .expect(200);
    expect((await t.get(`/connections/${created.id}`, cookie)).body).toMatchObject({
      writeCapable: null,
    });
  });

  it('다른 접속과 이름이 겹치면 거부한다', async () => {
    await createConnection();
    const other = await createConnection({ ...oracleInput, name: '다른 접속' });
    const res = await t
      .send('put', `/connections/${other.id}`, { ...oracleInput, password: '' }, cookie)
      .expect(409);
    expect(res.body).toMatchObject({ code: 'CONNECTION_NAME_TAKEN' });
  });
});

describe('연결 테스트 (FR-CON-02)', () => {
  it('성공하면 감지 요약을 돌려주고 일회용 풀을 닫는다', async () => {
    const target = omit(oracleInput, 'name', 'envLabel', 'tags');
    const res = await t.send('post', '/connections/test', target, cookie).expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      schema: 'QUARTZ',
      tableSetCount: 1,
      schedulerCount: 2,
      writeCapable: true,
    } satisfies Partial<ConnectionTestResult>);
    expect(fake.schemas.at(-1)).toBe('QUARTZ');
  });

  it.each([
    ['TARGET_UNREACHABLE', '연결할 수 없습니다'],
    ['TARGET_AUTH_FAILED', '로그인하지 못했습니다'],
    ['TARGET_TIMEOUT', '제한 시간 안에 응답하지 않았습니다'],
  ] as const)('실패하면 원인(%s)과 한국어 문구를 200으로 돌려준다', async (code, message) => {
    fake.error = new TargetError(code, { detail: `secret ${PASSWORD}` });
    const res = await t.send('post', '/connections/test', oracleInput, cookie).expect(200);
    expect(res.body).toMatchObject({ ok: false, code });
    expect((res.body as { message: string }).message).toContain(message);
    expectNoPassword(res.body);
  });

  it('수정 화면에서 비밀번호를 비우면 저장된 비밀번호로 시험한다', async () => {
    const created = await createConnection();
    await t
      .send(
        'post',
        '/connections/test',
        { ...oracleInput, password: '', connectionId: created.id },
        cookie,
      )
      .expect(200);
    expect(fake.connected.at(-1)).toMatchObject({ password: PASSWORD });

    const missing = await t
      .send('post', '/connections/test', { ...oracleInput, password: '' }, cookie)
      .expect(400);
    expect(JSON.stringify(missing.body)).toContain('비밀번호를 입력하세요');
  });
});

describe('감지와 스케줄러 등록 (FR-CON-03, 05, 07)', () => {
  async function register(id: number, selections: object[]): Promise<SchedulerDto[]> {
    const res = await t
      .send('post', `/connections/${id}/schedulers`, { selections }, cookie)
      .expect(201);
    return res.body as SchedulerDto[];
  }

  it('감지 후보를 고르면 감지한 테이블 정보와 활성 노드 수로 스케줄러를 등록한다', async () => {
    const conn = await createConnection();
    const detected = (
      await t.send('post', `/connections/${conn.id}/detect`, undefined, cookie).expect(200)
    ).body as DetectionDto;
    expect(detected.tableSets[0]!.schedulers.map((c) => c.registeredSchedulerId)).toEqual([
      null,
      null,
    ]);
    expect(detected.unusable).toEqual([
      { prefix: 'OLD_', reason: 'MISSING_TABLES', tables: ['LOCKS'] },
    ]);

    const [billing] = await register(conn.id, [
      { prefix: 'QRTZ_', schedName: 'Billing', displayName: '정산' },
    ]);
    expect(billing).toMatchObject({
      connectionId: conn.id,
      tablePrefix: 'QRTZ_',
      schedName: 'Billing',
      displayName: '정산',
      boolFormat: '10',
      expectedNodeCount: 2,
      misfireThresholdMs: 60_000,
      overdueGraceMs: 60_000,
      checkinMultiplier: 3,
      pollIntervalSec: 60,
      features,
    });
    expect(billing!.tableNames.TRIGGERS).toBe('QRTZ_TRIGGERS');

    const again = (
      await t.send('post', `/connections/${conn.id}/detect`, undefined, cookie).expect(200)
    ).body as DetectionDto;
    expect(again.tableSets[0]!.schedulers.map((c) => c.registeredSchedulerId)).toEqual([
      billing!.id,
      null,
    ]);
    expect(again.refreshedSchedulerIds).toEqual([billing!.id]);
    expect((await t.get(`/connections/${conn.id}`, cookie)).body).toMatchObject({
      schedulerCount: 1,
    });
  });

  it('표시 이름을 비우면 SCHED_NAME을 쓰고, 이미 등록된 후보와 감지되지 않은 후보는 거부한다', async () => {
    const conn = await createConnection();
    const [reports] = await register(conn.id, [
      { prefix: 'QRTZ_', schedName: 'Reports', displayName: '' },
    ]);
    expect(reports!.displayName).toBe('Reports');

    const dup = await t
      .send(
        'post',
        `/connections/${conn.id}/schedulers`,
        { selections: [{ prefix: 'QRTZ_', schedName: 'Reports' }] },
        cookie,
      )
      .expect(409);
    expect(dup.body).toMatchObject({ code: 'SCHEDULER_ALREADY_REGISTERED' });

    const unknown = await t
      .send(
        'post',
        `/connections/${conn.id}/schedulers`,
        { selections: [{ prefix: 'X_', schedName: 'Nope' }] },
        cookie,
      )
      .expect(409);
    expect(unknown.body).toMatchObject({ code: 'SCHEDULER_NOT_DETECTED' });
  });

  it('재감지에서 사라진 스케줄러는 missing으로 알리고, 남은 스케줄러는 새 정보로 갱신한다', async () => {
    const conn = await createConnection();
    const [billing, reports] = await register(conn.id, [
      { prefix: 'QRTZ_', schedName: 'Billing' },
      { prefix: 'QRTZ_', schedName: 'Reports' },
    ]);
    const next = detection();
    next.tableSets[0]!.schedulers = next.tableSets[0]!.schedulers.filter(
      (c) => c.schedName === 'Billing',
    );
    next.tableSets[0]!.boolFormat = 'YN';
    fake.result = next;
    t.clock.advance(1_000);

    const res = (
      await t.send('post', `/connections/${conn.id}/detect`, undefined, cookie).expect(200)
    ).body as DetectionDto;
    expect(res.refreshedSchedulerIds).toEqual([billing!.id]);
    expect(res.missingSchedulerIds).toEqual([reports!.id]);
    const updated = (await t.get(`/schedulers/${billing!.id}`, cookie).expect(200))
      .body as SchedulerDto;
    expect(updated.boolFormat).toBe('YN');
    expect(updated.detectedAt).toBe(t.clock.now);
  });

  it('감지 실패는 TRD §5.6의 상태 코드와 고정 문구로 응답한다', async () => {
    const conn = await createConnection();
    fake.error = new TargetError('TARGET_UNREACHABLE', { detail: 'host db-prod.corp.example' });
    const res = await t
      .send('post', `/connections/${conn.id}/detect`, undefined, cookie)
      .expect(502);
    expect(res.body).toEqual({
      code: 'TARGET_UNREACHABLE',
      message: new TargetError('TARGET_UNREACHABLE').message,
    });
    fake.error = new TargetError('TARGET_TIMEOUT');
    await t.send('post', `/connections/${conn.id}/detect`, undefined, cookie).expect(504);
  });

  it('스케줄러 설정을 바꾸고, 연체 유예가 misfire 임계값보다 작으면 거부한다', async () => {
    const conn = await createConnection();
    const [billing] = await register(conn.id, [{ prefix: 'QRTZ_', schedName: 'Billing' }]);
    const settings = {
      displayName: '정산 배치',
      misfireThresholdMs: 120_000,
      overdueGraceMs: 120_000,
      checkinMultiplier: 4,
      expectedNodeCount: 3,
      pollIntervalSec: 30,
    };
    const res = await t
      .send('put', `/schedulers/${billing!.id}/settings`, settings, cookie)
      .expect(200);
    expect(res.body).toMatchObject(settings);

    const bad = await t
      .send(
        'put',
        `/schedulers/${billing!.id}/settings`,
        { ...settings, overdueGraceMs: 60_000 },
        cookie,
      )
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('misfire 임계값 이상');
  });
});

describe('삭제 (FR-CON-05)', () => {
  it('삭제 영향을 미리 보여주고, 접속을 지우면 스케줄러도 함께 지운다', async () => {
    const conn = await createConnection();
    await t
      .send(
        'post',
        `/connections/${conn.id}/schedulers`,
        { selections: [{ prefix: 'QRTZ_', schedName: 'Billing', displayName: '정산' }] },
        cookie,
      )
      .expect(201);

    const impact = (await t.get(`/connections/${conn.id}/delete-impact`, cookie).expect(200))
      .body as DeleteImpactDto;
    expect(impact).toMatchObject({
      schedulers: [{ displayName: '정산', schedName: 'Billing' }],
      // 등록하면 기본 규칙 6종이 생긴다 (TRD §9.2)
      alertRuleCount: 6,
      openAlertCount: 0,
    });

    await t.send('delete', `/connections/${conn.id}`, undefined, cookie).expect(204);
    await t.get(`/connections/${conn.id}`, cookie).expect(404);
    await t.get(`/schedulers/${impact.schedulers[0]!.id}`, cookie).expect(404);
  });

  it('스케줄러만 등록 해제할 수 있다', async () => {
    const conn = await createConnection();
    const res = await t
      .send(
        'post',
        `/connections/${conn.id}/schedulers`,
        { selections: [{ prefix: 'QRTZ_', schedName: 'Billing' }] },
        cookie,
      )
      .expect(201);
    const [billing] = res.body as SchedulerDto[];
    await t.get(`/schedulers/${billing!.id}/delete-impact`, cookie).expect(200);
    await t.send('delete', `/schedulers/${billing!.id}`, undefined, cookie).expect(204);
    expect((await t.get(`/connections/${conn.id}`, cookie)).body).toMatchObject({
      schedulerCount: 0,
    });
  });
});

describe('감사 로그 (FR-AUD-01)', () => {
  it('모든 변경을 기록하고 비밀번호는 남기지 않는다', async () => {
    const conn = await createConnection();
    const rest = omit(oracleInput, 'password');
    await t
      .send('put', `/connections/${conn.id}`, { ...rest, password: 'New-Secret-1' }, cookie)
      .expect(200);
    await t.send('post', `/connections/${conn.id}/detect`, undefined, cookie).expect(200);
    const reg = await t
      .send(
        'post',
        `/connections/${conn.id}/schedulers`,
        { selections: [{ prefix: 'QRTZ_', schedName: 'Billing' }] },
        cookie,
      )
      .expect(201);
    const [billing] = reg.body as SchedulerDto[];
    await t
      .send(
        'put',
        `/schedulers/${billing!.id}/settings`,
        {
          displayName: 'x',
          misfireThresholdMs: 60_000,
          overdueGraceMs: 60_000,
          checkinMultiplier: 3,
          expectedNodeCount: 1,
          pollIntervalSec: 60,
        },
        cookie,
      )
      .expect(200);
    await t.send('delete', `/schedulers/${billing!.id}`, undefined, cookie).expect(204);
    await t.send('delete', `/connections/${conn.id}`, undefined, cookie).expect(204);

    const rows = t.app
      .get(MetaDbService)
      .sqlite.prepare(
        `SELECT action, result, connection_id, scheduler_id, target, before, after FROM audit_logs
          WHERE action LIKE 'connection.%' OR action LIKE 'scheduler.%' ORDER BY id`,
      )
      .all() as { action: string; result: string; connection_id: number | null; after: string }[];
    expect(rows.map((r) => [r.action, r.result])).toEqual([
      ['connection.create', 'success'],
      ['connection.update', 'success'],
      ['connection.detect', 'success'],
      ['scheduler.register', 'success'],
      ['scheduler.update', 'success'],
      ['scheduler.delete', 'success'],
      ['connection.delete', 'success'],
    ]);
    expect(rows.slice(1).every((r) => r.connection_id === conn.id)).toBe(true);
    expect(JSON.parse(rows[1]!.after)).toMatchObject({ passwordChanged: true });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('New-Secret-1');
  });

  it('실패한 감지도 원인 코드와 함께 기록한다', async () => {
    const conn = await createConnection();
    fake.error = new TargetError('TARGET_AUTH_FAILED');
    await t.send('post', `/connections/${conn.id}/detect`, undefined, cookie).expect(502);
    const row = t.app
      .get(MetaDbService)
      .sqlite.prepare(
        `SELECT result, error_code FROM audit_logs WHERE action = 'connection.detect'`,
      )
      .get();
    expect(row).toEqual({ result: 'failure', error_code: 'TARGET_AUTH_FAILED' });
  });
});
