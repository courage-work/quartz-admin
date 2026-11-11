import type { AlertRuleDto, AuditLogPage } from '@qa/shared';
import { TargetError } from '@qa/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../auth/test-support.js';
import { tempDataDir } from '../meta-db/test-support.js';
import { addScheduler, FakeTarget, MIN, startAlertsApp } from './test-support.js';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  cleanup?.();
  cleanup = undefined;
});

async function start(fake: FakeTarget, dataDir?: string, restartOf?: TestApp) {
  const started = await startAlertsApp(fake, {
    ...(dataDir ? { dataDir } : {}),
    ...(restartOf ? { restartOf } : {}),
  });
  t = started.app;
  return started;
}

describe('기본 규칙 세트 (TRD §9.2)', () => {
  it('스케줄러를 등록하면 6종 규칙을 만들고 인앱 채널에 연결한다', async () => {
    const fake = new FakeTarget();
    const { app, cookie, rules, sqlite } = await start(fake);
    const s = await addScheduler(app, cookie);
    const list = await rules(s.id);
    expect(list.map((r) => [r.type, r.severity, r.renotifyMinutes, r.enabled])).toEqual([
      ['OVERDUE', 'warning', null, true],
      ['TRIGGER_ERROR', 'critical', 60, true],
      ['BLOCKED_LONG', 'warning', null, true],
      ['NODE_MISSING', 'warning', null, true],
      ['CLUSTER_DOWN', 'critical', 60, true],
      ['MONITOR_UNREACHABLE', 'critical', 60, true],
    ]);
    expect(list.find((r) => r.type === 'BLOCKED_LONG')?.params).toEqual({ minutes: 30 });
    const channels = sqlite.prepare("SELECT id, type FROM channels WHERE type = 'inapp'").all() as {
      id: number;
    }[];
    expect(channels).toHaveLength(1);
    expect(
      list.every((r) => r.channelIds.length === 1 && r.channelIds[0] === channels[0]!.id),
    ).toBe(true);
  });

  it('B-24 이전에 등록해 규칙이 없는 스케줄러에는 기동할 때 한 번만 채운다', async () => {
    const tmp = tempDataDir();
    cleanup = tmp.cleanup;
    const fake = new FakeTarget();
    const first = await start(fake, tmp.dir);
    const s = await addScheduler(first.app, first.cookie);
    // 규칙이 없던 옛 상태를 흉내 낸다
    first.sqlite.prepare('DELETE FROM alert_rules').run();
    first.sqlite
      .prepare("DELETE FROM settings WHERE key = 'alerts.default_rules_backfilled'")
      .run();
    await first.app.close();

    const second = await start(fake, tmp.dir);
    expect(await second.rules(s.id)).toHaveLength(6);
    // 사용자가 규칙을 모두 지운 뒤 다시 기동해도 되살리지 않는다
    second.sqlite.prepare('DELETE FROM alert_rules').run();
    await second.app.close();
    const third = await start(fake, tmp.dir);
    expect(await third.rules(s.id)).toHaveLength(0);
  });
});

describe('알림 엔진 (TRD §9.3)', () => {
  it('ERROR 트리거: 열림 → 같은 대상은 조용히 → 새 대상이면 update → 재알림 → 해소', async () => {
    const fake = new FakeTarget();
    const { app, cookie, poll, alerts, events } = await start(fake);
    const s = await addScheduler(app, cookie);

    await poll(s.id);
    expect((await alerts(s.id)).open).toEqual([]);

    fake.errors = [{ group: 'g', name: 'bad' }];
    await poll(s.id);
    const opened = (await alerts(s.id)).open;
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      type: 'TRIGGER_ERROR',
      severity: 'critical',
      status: 'open',
      notified: true,
      suppressed: false,
      affected: { kind: 'triggers', total: 1, triggers: [{ group: 'g', name: 'bad' }] },
    });
    expect(events()).toEqual(['TRIGGER_ERROR:fire']);

    app.clock.advance(MIN);
    await poll(s.id);
    expect(events()).toEqual(['TRIGGER_ERROR:fire']);

    fake.errors.push({ group: 'g', name: 'worse' });
    await poll(s.id);
    expect(events()).toEqual(['TRIGGER_ERROR:fire', 'TRIGGER_ERROR:update']);

    // 마지막 발송(update) 뒤 60분
    app.clock.advance(60 * MIN);
    await poll(s.id);
    expect(events().at(-1)).toBe('TRIGGER_ERROR:reminder');

    fake.errors = [];
    await poll(s.id);
    const after = await alerts(s.id);
    expect(after.open).toEqual([]);
    expect(after.resolved[0]).toMatchObject({ type: 'TRIGGER_ERROR', status: 'resolved' });
    expect(events().at(-1)).toBe('TRIGGER_ERROR:resolve');
  });

  it('노드가 모두 중지되면 CLUSTER_DOWN만 보내고 OVERDUE·NODE_MISSING은 기록만 한다. 복구되면 남은 연체를 그때 보낸다', async () => {
    const fake = new FakeTarget();
    const { app, cookie, poll, alerts, events } = await start(fake);
    const s = await addScheduler(app, cookie);
    await poll(s.id);

    fake.nodes = { 'node-1': 10 * MIN, 'node-2': 10 * MIN };
    fake.overdue = [{ group: 'g', name: 'late', lateMs: 5 * MIN }];
    await poll(s.id);
    const down = await alerts(s.id);
    expect(down.open.map((a) => [a.type, a.notified, a.suppressed])).toEqual([
      ['CLUSTER_DOWN', true, false],
      // 같은 심각도(warning)는 최근 순(같은 회차면 나중에 연 것부터)
      ['NODE_MISSING', false, true],
      ['OVERDUE', false, true],
    ]);
    expect(events()).toEqual(['CLUSTER_DOWN:fire']);

    // 연체가 늘어도 억제 중에는 보내지 않는다
    fake.overdue.push({ group: 'g', name: 'later', lateMs: 3 * MIN });
    await poll(s.id);
    expect(events()).toEqual(['CLUSTER_DOWN:fire']);

    // 노드가 돌아왔지만 연체는 아직 남았다
    fake.nodes = { 'node-1': 1_000, 'node-2': 1_000 };
    await poll(s.id);
    expect(events()).toEqual(['CLUSTER_DOWN:fire', 'CLUSTER_DOWN:resolve', 'OVERDUE:fire']);
    // NODE_MISSING은 한 번도 보내지 않고 해소됐으므로 해소 알림도 없다
    expect((await alerts(s.id)).open.map((a) => a.type)).toEqual(['OVERDUE']);

    fake.overdue = [];
    await poll(s.id);
    expect(events().at(-1)).toBe('OVERDUE:resolve');
  });

  it('감시가 연속으로 실패하면 MONITOR_UNREACHABLE을 열고, 그동안 다른 알림은 그대로 둔다', async () => {
    const fake = new FakeTarget();
    const { app, cookie, poll, alerts, events } = await start(fake);
    const s = await addScheduler(app, cookie);
    fake.errors = [{ group: 'g', name: 'bad' }];
    await poll(s.id);
    expect(events()).toEqual(['TRIGGER_ERROR:fire']);

    fake.failing = new TargetError('TARGET_UNREACHABLE');
    await poll(s.id);
    await poll(s.id);
    expect((await alerts(s.id)).open.map((a) => a.type)).toEqual(['TRIGGER_ERROR']);
    await poll(s.id);
    const open = (await alerts(s.id)).open;
    expect(open.map((a) => a.type).sort()).toEqual(['MONITOR_UNREACHABLE', 'TRIGGER_ERROR']);
    expect(open.find((a) => a.type === 'MONITOR_UNREACHABLE')?.affected).toMatchObject({
      kind: 'monitor',
      failures: 3,
      errorCode: 'TARGET_UNREACHABLE',
    });
    expect(events()).toEqual(['TRIGGER_ERROR:fire', 'MONITOR_UNREACHABLE:fire']);

    fake.failing = null;
    fake.errors = [];
    await poll(s.id);
    expect((await alerts(s.id)).open).toEqual([]);
    expect(events().slice(2).sort()).toEqual([
      'MONITOR_UNREACHABLE:resolve',
      'TRIGGER_ERROR:resolve',
    ]);
  });

  it('재시작해도 열린 알림과 BLOCKED 지속 시간이 이어진다', async () => {
    const tmp = tempDataDir();
    cleanup = tmp.cleanup;
    const fake = new FakeTarget();
    const first = await start(fake, tmp.dir);
    const s = await addScheduler(first.app, first.cookie);
    fake.blocked = [{ group: 'g', name: 'stuck' }];
    fake.errors = [{ group: 'g', name: 'bad' }];
    await first.poll(s.id);
    const since = first.app.clock.now;
    expect((await first.alerts(s.id)).open.map((a) => a.type)).toEqual(['TRIGGER_ERROR']);
    await first.app.close();

    // 새 프로세스. 테스트 시계는 같은 시각에서 다시 시작하므로 처음 본 뒤 31분이 지난 것으로 만든다
    const second = await start(fake, tmp.dir, first.app);
    second.app.clock.now = since + 31 * MIN;
    await second.poll(s.id);
    const open = (await second.alerts(s.id)).open;
    expect(open.map((a) => a.type).sort()).toEqual(['BLOCKED_LONG', 'TRIGGER_ERROR']);
    expect(open.find((a) => a.type === 'BLOCKED_LONG')?.affected).toMatchObject({
      triggers: [{ group: 'g', name: 'stuck', since }],
    });
    // 이어진 ERROR 알림은 다시 열지 않는다
    expect(second.events()).toEqual(['TRIGGER_ERROR:fire', 'BLOCKED_LONG:fire']);
  });

  it('OVERDUE는 misfire 임계값 + 유예 안에 도구가 재개한 트리거를 뺀다', async () => {
    const fake = new FakeTarget();
    const { app, cookie, poll, alerts, sqlite } = await start(fake);
    const s = await addScheduler(app, cookie);
    sqlite
      .prepare(
        "INSERT INTO audit_logs (at, action, scheduler_id, after, result) VALUES (?, 'trigger.resume', ?, ?, 'success')",
      )
      .run(
        app.clock.now,
        s.id,
        JSON.stringify({
          changes: [{ group: 'g', name: 'resumed', from: 'PAUSED', to: 'WAITING' }],
        }),
      );
    fake.overdue = [{ group: 'g', name: 'resumed', lateMs: 5 * MIN }];
    await poll(s.id);
    expect((await alerts(s.id)).open).toEqual([]);

    // 기본값 60초 + 60초가 지나면 더는 빼지 않는다
    app.clock.advance(2 * MIN + 1);
    await poll(s.id);
    expect((await alerts(s.id)).open.map((a) => a.type)).toEqual(['OVERDUE']);
  });
});

describe('규칙 관리 API (FR-ALT-06)', () => {
  it('추가·수정·삭제와 검증, 감사 기록', async () => {
    const fake = new FakeTarget();
    const { app, cookie } = await start(fake);
    const s = await addScheduler(app, cookie);

    const created = (
      await app
        .send(
          'post',
          `/schedulers/${s.id}/alert-rules`,
          {
            type: 'OVERDUE',
            params: {},
            scope: { kind: 'groups', groups: ['billing'] },
            severity: 'critical',
            renotifyMinutes: 30,
            enabled: true,
          },
          cookie,
        )
        .expect(201)
    ).body as AlertRuleDto;
    expect(created).toMatchObject({
      schedulerId: s.id,
      type: 'OVERDUE',
      scope: { kind: 'groups', groups: ['billing'] },
      severity: 'critical',
      renotifyMinutes: 30,
    });
    expect(created.channelIds).toHaveLength(1);

    // 스케줄러 단위 규칙의 범위는 늘 전체다
    const nodeRule = (
      await app
        .send(
          'post',
          `/schedulers/${s.id}/alert-rules`,
          { type: 'NODE_MISSING', severity: 'critical', renotifyMinutes: null, enabled: true },
          cookie,
        )
        .expect(201)
    ).body as AlertRuleDto;
    expect(nodeRule.scope).toEqual({ kind: 'all' });

    const bad = await app
      .send(
        'post',
        `/schedulers/${s.id}/alert-rules`,
        {
          type: 'BLOCKED_LONG',
          params: { minutes: 0 },
          scope: { kind: 'all' },
          severity: 'warning',
          renotifyMinutes: null,
          enabled: true,
        },
        cookie,
      )
      .expect(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    // 타입은 바꿀 수 없다
    await app
      .send(
        'put',
        `/alert-rules/${created.id}`,
        {
          type: 'TRIGGER_ERROR',
          params: {},
          scope: { kind: 'all' },
          severity: 'critical',
          renotifyMinutes: null,
          enabled: true,
        },
        cookie,
      )
      .expect(400);
    const updated = (
      await app
        .send(
          'put',
          `/alert-rules/${created.id}`,
          {
            type: 'OVERDUE',
            params: {},
            scope: { kind: 'all' },
            severity: 'warning',
            renotifyMinutes: null,
            enabled: false,
          },
          cookie,
        )
        .expect(200)
    ).body as AlertRuleDto;
    expect(updated).toMatchObject({
      scope: { kind: 'all' },
      enabled: false,
      renotifyMinutes: null,
    });

    await app.send('delete', `/alert-rules/${created.id}`, undefined, cookie).expect(204);
    await app.send('delete', `/alert-rules/${created.id}`, undefined, cookie).expect(404);

    const logs = (await app.get('/audit-logs?action=alert_rule.update', cookie).expect(200))
      .body as AuditLogPage;
    expect(logs.items[0]).toMatchObject({
      action: 'alert_rule.update',
      targetType: 'alert_rule',
      schedulerId: s.id,
      result: 'success',
      before: { severity: 'critical', enabled: true },
      after: { severity: 'warning', enabled: false },
    });
    const deleted = (await app.get('/audit-logs?action=alert_rule.delete', cookie).expect(200))
      .body as AuditLogPage;
    expect(deleted.items.map((l) => l.result)).toEqual(['failure', 'success']);
  });

  it('끈 규칙의 열린 알림은 다음 회차에, 지운 규칙의 열린 알림은 바로 발송 없이 해소한다', async () => {
    const fake = new FakeTarget();
    const { app, cookie, poll, alerts, rules, events } = await start(fake);
    const s = await addScheduler(app, cookie);
    fake.errors = [{ group: 'g', name: 'bad' }];
    fake.nodes = { 'node-1': 1_000 };
    await poll(s.id);
    expect((await alerts(s.id)).open.map((a) => a.type).sort()).toEqual([
      'NODE_MISSING',
      'TRIGGER_ERROR',
    ]);

    const list = await rules(s.id);
    const errorRule = list.find((r) => r.type === 'TRIGGER_ERROR')!;
    const nodeRule = list.find((r) => r.type === 'NODE_MISSING')!;
    await app
      .send('put', `/alert-rules/${errorRule.id}`, { ...errorRule, enabled: false }, cookie)
      .expect(200);
    await app.send('delete', `/alert-rules/${nodeRule.id}`, undefined, cookie).expect(204);
    expect((await alerts(s.id)).open.map((a) => a.type)).toEqual(['TRIGGER_ERROR']);

    await poll(s.id);
    expect((await alerts(s.id)).open).toEqual([]);
    expect(events()).toEqual(['TRIGGER_ERROR:fire', 'NODE_MISSING:fire']);
  });

  it('없는 스케줄러는 404', async () => {
    const { app, cookie } = await start(new FakeTarget());
    await app.get('/schedulers/999/alert-rules', cookie).expect(404);
    await app.get('/schedulers/999/alerts', cookie).expect(404);
  });
});
