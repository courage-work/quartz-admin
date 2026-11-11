import type { AlertAffected, MonitorData, NodeDto } from '@qa/shared';
import { describe, expect, it } from 'vitest';
import {
  affectedKeys,
  evaluateRule,
  observeBlocked,
  stepAlert,
  triggerKeyOf,
  type AlertRuleSpec,
  type EvaluationInput,
  type RuleEvaluation,
} from './evaluate.js';

const NOW = 1_800_000_000_000;

function node(name: string, active: boolean): NodeDto {
  return {
    instanceName: name,
    lastCheckinTime: NOW - (active ? 1_000 : 600_000),
    checkinInterval: 7_500,
    active,
    sinceCheckinMs: active ? 1_000 : 600_000,
  };
}

function data(over: Partial<MonitorData> = {}): MonitorData {
  return {
    dbNow: NOW,
    triggerCounts: { WAITING: 3 },
    nodes: [node('n1', true), node('n2', true)],
    executingCount: 0,
    overdueCount: 0,
    overdue: [],
    errorTriggers: [],
    blockedTriggers: [],
    ...over,
  };
}

function input(over: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    result: { ok: true, data: data() },
    expectedNodeCount: 2,
    blockedSince: new Map(),
    recentlyResumed: new Set(),
    ...over,
  };
}

const rule = (type: AlertRuleSpec['type'], over: Partial<AlertRuleSpec> = {}): AlertRuleSpec => ({
  type,
  params: {},
  scope: { kind: 'all' },
  ...over,
});

const failed = (consecutiveFailures: number): EvaluationInput['result'] => ({
  ok: false,
  consecutiveFailures,
  errorCode: 'TARGET_UNREACHABLE',
  errorMessage: '대상 DB에 연결하지 못했습니다',
});

describe('규칙 판정 (TRD §9.2)', () => {
  it('OVERDUE: 연체 트리거가 있으면 성립하고, 적용 범위와 최근 재개한 트리거를 거른다', () => {
    const overdue = [
      { group: 'a', name: 't1', nextFireTime: NOW - 300_000 },
      { group: 'a', name: 't2', nextFireTime: NOW - 200_000 },
      { group: 'b', name: 't3', nextFireTime: NOW - 100_000 },
    ];
    const d = data({ overdueCount: 3, overdue });
    expect(evaluateRule(rule('OVERDUE'), input({ result: { ok: true, data: d } }))).toEqual({
      firing: true,
      affected: { kind: 'triggers', total: 3, triggers: overdue },
    });
    // 그룹 b만
    const b = evaluateRule(
      rule('OVERDUE', { scope: { kind: 'groups', groups: ['b'] } }),
      input({ result: { ok: true, data: d } }),
    );
    expect(b).toMatchObject({ affected: { total: 1, triggers: [{ name: 't3' }] } });
    // 도구가 방금 재개한 t1, t2를 빼면 t3만 남는다
    const resumed = evaluateRule(
      rule('OVERDUE'),
      input({
        result: { ok: true, data: d },
        recentlyResumed: new Set([triggerKeyOf(overdue[0]!), triggerKeyOf(overdue[1]!)]),
      }),
    );
    expect(resumed).toMatchObject({ affected: { total: 1, triggers: [{ name: 't3' }] } });
    // 모두 재개한 트리거면 해소
    expect(
      evaluateRule(
        rule('OVERDUE', { scope: { kind: 'triggers', triggers: [{ group: 'a', name: 't1' }] } }),
        input({
          result: { ok: true, data: d },
          recentlyResumed: new Set([triggerKeyOf(overdue[0]!)]),
        }),
      ),
    ).toEqual({ firing: false });
  });

  it('OVERDUE: 전체 범위면 목록 상한을 넘은 연체 수도 센다', () => {
    const d = data({
      overdueCount: 900,
      overdue: [{ group: 'a', name: 't1', nextFireTime: NOW - 1 }],
    });
    expect(evaluateRule(rule('OVERDUE'), input({ result: { ok: true, data: d } }))).toMatchObject({
      affected: { total: 900 },
    });
  });

  it('TRIGGER_ERROR: ERROR 트리거가 범위 안에 있으면 성립', () => {
    const d = data({ errorTriggers: [{ group: 'a', name: 'x' }] });
    expect(evaluateRule(rule('TRIGGER_ERROR'), input({ result: { ok: true, data: d } }))).toEqual({
      firing: true,
      affected: { kind: 'triggers', total: 1, triggers: [{ group: 'a', name: 'x' }] },
    });
    expect(
      evaluateRule(
        rule('TRIGGER_ERROR', { scope: { kind: 'groups', groups: ['b'] } }),
        input({ result: { ok: true, data: d } }),
      ),
    ).toEqual({ firing: false });
  });

  it('BLOCKED_LONG: 처음 본 지 설정 시간이 지난 BLOCKED만, PAUSED_BLOCKED는 빼고', () => {
    const blocked = [
      { group: 'a', name: 'old', state: 'BLOCKED' },
      { group: 'a', name: 'new', state: 'BLOCKED' },
      { group: 'a', name: 'paused', state: 'PAUSED_BLOCKED' },
    ];
    const since = new Map([
      [triggerKeyOf(blocked[0]!), NOW - 31 * 60_000],
      [triggerKeyOf(blocked[1]!), NOW - 5 * 60_000],
      [triggerKeyOf(blocked[2]!), NOW - 60 * 60_000],
    ]);
    const d = data({ blockedTriggers: blocked });
    expect(
      evaluateRule(
        rule('BLOCKED_LONG', { params: { minutes: 30 } }),
        input({ result: { ok: true, data: d }, blockedSince: since }),
      ),
    ).toEqual({
      firing: true,
      affected: {
        kind: 'triggers',
        total: 1,
        triggers: [{ group: 'a', name: 'old', state: 'BLOCKED', since: NOW - 31 * 60_000 }],
      },
    });
    expect(
      evaluateRule(
        rule('BLOCKED_LONG', { params: { minutes: 60 } }),
        input({ result: { ok: true, data: d }, blockedSince: since }),
      ),
    ).toEqual({ firing: false });
  });

  it('NODE_MISSING·CLUSTER_DOWN: 활성 노드 수로 판정', () => {
    const one = data({ nodes: [node('n1', true), node('n2', false)] });
    const none = data({ nodes: [node('n1', false)] });
    expect(evaluateRule(rule('NODE_MISSING'), input())).toEqual({ firing: false });
    expect(evaluateRule(rule('NODE_MISSING'), input({ result: { ok: true, data: one } }))).toEqual({
      firing: true,
      affected: {
        kind: 'nodes',
        active: 1,
        expected: 2,
        nodes: [
          { instanceName: 'n1', active: true, lastCheckinTime: NOW - 1_000 },
          { instanceName: 'n2', active: false, lastCheckinTime: NOW - 600_000 },
        ],
      },
    });
    expect(evaluateRule(rule('CLUSTER_DOWN'), input({ result: { ok: true, data: one } }))).toEqual({
      firing: false,
    });
    expect(
      evaluateRule(rule('CLUSTER_DOWN'), input({ result: { ok: true, data: none } })),
    ).toMatchObject({ firing: true, affected: { active: 0 } });
    // 노드 행이 하나도 없어도(살아남은 노드가 지움) 활성 0개
    expect(
      evaluateRule(
        rule('CLUSTER_DOWN'),
        input({ result: { ok: true, data: data({ nodes: [] }) } }),
      ),
    ).toMatchObject({ firing: true });
  });

  it('MONITOR_UNREACHABLE: 연속 실패 횟수에 이르면 성립, 성공하면 해소, 그 사이는 판정 불가', () => {
    const r = rule('MONITOR_UNREACHABLE', { params: { failures: 3 } });
    expect(evaluateRule(r, input({ result: failed(2) }))).toBeNull();
    expect(evaluateRule(r, input({ result: failed(3) }))).toEqual({
      firing: true,
      affected: {
        kind: 'monitor',
        failures: 3,
        errorCode: 'TARGET_UNREACHABLE',
        errorMessage: '대상 DB에 연결하지 못했습니다',
      },
    });
    expect(evaluateRule(r, input())).toEqual({ firing: false });
  });

  it('감시가 실패한 회차에는 다른 규칙을 판정하지 않는다', () => {
    for (const type of [
      'OVERDUE',
      'TRIGGER_ERROR',
      'BLOCKED_LONG',
      'NODE_MISSING',
      'CLUSTER_DOWN',
    ] as const) {
      expect(evaluateRule(rule(type), input({ result: failed(5) }))).toBeNull();
    }
  });
});

describe('BLOCKED 관찰', () => {
  it('처음 본 시각을 유지하고, BLOCKED ↔ PAUSED_BLOCKED는 같은 막힘으로 보며, 풀리면 지운다', () => {
    const first = observeBlocked([], [{ group: 'a', name: 't', state: 'BLOCKED' }], 1_000);
    expect(first.upserts).toEqual([
      { group: 'a', name: 't', state: 'BLOCKED', firstSeenAt: 1_000 },
    ]);
    const same = observeBlocked(first.next, [{ group: 'a', name: 't', state: 'BLOCKED' }], 2_000);
    expect(same.upserts).toEqual([]);
    expect(same.next[0]?.firstSeenAt).toBe(1_000);
    const paused = observeBlocked(
      same.next,
      [{ group: 'a', name: 't', state: 'PAUSED_BLOCKED' }],
      3_000,
    );
    expect(paused.upserts).toEqual([
      { group: 'a', name: 't', state: 'PAUSED_BLOCKED', firstSeenAt: 1_000 },
    ]);
    const gone = observeBlocked(paused.next, [], 4_000);
    expect(gone.removed).toEqual([{ group: 'a', name: 't' }]);
    expect(gone.next).toEqual([]);
  });
});

describe('알림 수명주기 (TRD §9.3)', () => {
  const triggers = (...names: string[]): AlertAffected => ({
    kind: 'triggers',
    total: names.length,
    triggers: names.map((name) => ({ group: 'g', name })),
  });
  const firing = (affected: AlertAffected): RuleEvaluation => ({ firing: true, affected });
  const opts = { now: NOW, renotifyMinutes: 60, suppressed: false };

  it('처음 성립하면 열고 fire, 해소되면 resolve', () => {
    expect(stepAlert(null, firing(triggers('a')), opts)).toEqual({
      action: 'open',
      affected: triggers('a'),
      notify: 'fire',
    });
    expect(
      stepAlert(
        { status: 'open', affected: triggers('a'), lastNotifiedAt: NOW - 1 },
        { firing: false },
        opts,
      ),
    ).toEqual({ action: 'resolve', notify: 'resolve' });
    expect(stepAlert(null, { firing: false }, opts)).toEqual({ action: 'none' });
  });

  it('열린 알림: 같은 대상이면 조용히 갱신, 새 대상이 생기면 update, 재알림 간격이 지나면 reminder', () => {
    const open = {
      status: 'open' as const,
      affected: triggers('a'),
      lastNotifiedAt: NOW - 10 * 60_000,
    };
    expect(stepAlert(open, firing(triggers('a')), opts)).toEqual({
      action: 'refresh',
      affected: triggers('a'),
      notify: null,
    });
    // 대상이 줄기만 하면 발송하지 않는다
    expect(
      stepAlert({ ...open, affected: triggers('a', 'b') }, firing(triggers('a')), opts),
    ).toMatchObject({
      notify: null,
    });
    expect(stepAlert(open, firing(triggers('a', 'b')), opts)).toMatchObject({ notify: 'update' });
    expect(
      stepAlert({ ...open, lastNotifiedAt: NOW - 60 * 60_000 }, firing(triggers('a')), opts),
    ).toMatchObject({ notify: 'reminder' });
    expect(
      stepAlert({ ...open, lastNotifiedAt: NOW - 600 * 60_000 }, firing(triggers('a')), {
        ...opts,
        renotifyMinutes: null,
      }),
    ).toMatchObject({ notify: null });
  });

  it('확인한(acked) 알림은 재알림을 멈추지만 해소 알림은 보낸다', () => {
    const acked = {
      status: 'acked' as const,
      affected: triggers('a'),
      lastNotifiedAt: NOW - 600 * 60_000,
    };
    expect(stepAlert(acked, firing(triggers('a')), opts)).toMatchObject({ notify: null });
    expect(stepAlert(acked, { firing: false }, opts)).toEqual({
      action: 'resolve',
      notify: 'resolve',
    });
  });

  it('억제 중이면 상태만 바꾸고 발송하지 않으며, 풀린 뒤에도 열려 있으면 fire를 보낸다', () => {
    const suppressed = { ...opts, suppressed: true };
    expect(stepAlert(null, firing(triggers('a')), suppressed)).toEqual({
      action: 'open',
      affected: triggers('a'),
      notify: null,
    });
    const silent = { status: 'open' as const, affected: triggers('a'), lastNotifiedAt: null };
    expect(stepAlert(silent, firing(triggers('a', 'b')), suppressed)).toMatchObject({
      notify: null,
    });
    expect(stepAlert(silent, firing(triggers('a')), opts)).toMatchObject({ notify: 'fire' });
    // 한 번도 보내지 않은 알림의 해소는 보내지 않는다
    expect(stepAlert(silent, { firing: false }, opts)).toEqual({ action: 'resolve', notify: null });
  });

  it('판정 불가면 그대로 둔다', () => {
    const open = {
      status: 'open' as const,
      affected: triggers('a'),
      lastNotifiedAt: NOW - 600 * 60_000,
    };
    expect(stepAlert(open, null, opts)).toEqual({ action: 'none' });
  });

  it('노드 알림은 빠진 노드 수가 늘 때만 새 항목이다', () => {
    const nodes = (active: number): AlertAffected => ({
      kind: 'nodes',
      active,
      expected: 3,
      nodes: [],
    });
    expect(affectedKeys(nodes(2))).toEqual(['missing:1']);
    const open = { status: 'open' as const, affected: nodes(2), lastNotifiedAt: NOW - 1 };
    expect(stepAlert(open, firing(nodes(1)), opts)).toMatchObject({ notify: 'update' });
    expect(stepAlert({ ...open, affected: nodes(1) }, firing(nodes(2)), opts)).toMatchObject({
      notify: null,
    });
  });
});
