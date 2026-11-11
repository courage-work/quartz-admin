import { type AlertRuleDto, alertRuleInputSchema } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import {
  describeAffected,
  describeAlertStatus,
  describeCondition,
  describeRenotify,
  describeScope,
  ruleFormPathOf,
  ruleFormValues,
  toRuleRequest,
} from './alerts';

const thresholds = {
  misfireThresholdMs: 60_000,
  overdueGraceMs: 60_000,
  expectedNodeCount: 2,
  checkinMultiplier: 3,
};

const rule = (over: Partial<AlertRuleDto> = {}): AlertRuleDto => ({
  id: 1,
  schedulerId: 1,
  type: 'BLOCKED_LONG',
  params: { minutes: 45 },
  scope: { kind: 'groups', groups: ['billing', 'batch'] },
  severity: 'warning',
  renotifyMinutes: 90,
  enabled: true,
  channelIds: [1],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('알림 규칙 문구', () => {
  it('조건은 스케줄러 설정과 매개변수로 쓴다', () => {
    expect(describeCondition({ type: 'OVERDUE', params: {} }, thresholds)).toBe(
      '대기 트리거가 다음 실행 시각보다 2분 넘게 밀림',
    );
    expect(describeCondition({ type: 'BLOCKED_LONG', params: { minutes: 45 } }, thresholds)).toBe(
      'BLOCKED가 45분 넘게 이어짐',
    );
    expect(describeCondition({ type: 'NODE_MISSING', params: {} }, thresholds)).toBe(
      '활성 노드가 기대 노드 수(2개)보다 적음',
    );
    expect(describeCondition({ type: 'MONITOR_UNREACHABLE', params: {} }, thresholds)).toBe(
      '감시가 3회 연속 실패',
    );
  });

  it('범위·재알림·대상·상태', () => {
    expect(describeScope({ kind: 'all' })).toBe('전체');
    expect(describeScope({ kind: 'groups', groups: ['a', 'b', 'c'] })).toBe('그룹 a 외 2개');
    expect(describeScope({ kind: 'triggers', triggers: [{ group: 'g', name: 't' }] })).toBe(
      '트리거 g.t',
    );
    expect(describeRenotify(null)).toBe('안 함');
    expect(describeRenotify(120)).toBe('2시간마다');
    expect(describeRenotify(90)).toBe('90분마다');
    expect(
      describeAffected({
        kind: 'triggers',
        total: 3,
        triggers: [{ group: 'g', name: 'late' }],
      }),
    ).toBe('g.late 외 2개');
    expect(describeAffected({ kind: 'nodes', active: 1, expected: 2, nodes: [] })).toBe(
      '활성 노드 1개 / 기대 2개',
    );
    expect(describeAlertStatus({ status: 'open', suppressed: true, notified: false })).toBe(
      '열림 · 억제 중',
    );
    expect(describeAlertStatus({ status: 'acked', suppressed: false, notified: true })).toBe(
      '확인함',
    );
  });
});

describe('규칙 폼', () => {
  it('저장된 규칙을 폼 값으로 바꾼 뒤 그대로 보내면 같은 요청이 된다', () => {
    const values = ruleFormValues(rule());
    expect(values).toMatchObject({ minutes: '45', scopeKind: 'groups', groups: 'billing\nbatch' });
    expect(alertRuleInputSchema.parse(toRuleRequest(values))).toEqual({
      type: 'BLOCKED_LONG',
      params: { minutes: 45 },
      scope: { kind: 'groups', groups: ['billing', 'batch'] },
      severity: 'warning',
      renotifyMinutes: 90,
      enabled: true,
    });
  });

  it('스케줄러 단위 규칙은 범위를 보내지 않고, 빈 재알림은 null', () => {
    const values = {
      ...ruleFormValues(),
      type: 'CLUSTER_DOWN' as const,
      scopeKind: 'groups' as const,
    };
    expect(alertRuleInputSchema.parse(toRuleRequest(values))).toMatchObject({
      scope: { kind: 'all' },
      params: {},
      renotifyMinutes: null,
    });
  });

  it('검증 오류 경로를 폼 입력으로 되돌린다', () => {
    const values = {
      ...ruleFormValues(),
      type: 'BLOCKED_LONG' as const,
      minutes: '0',
      scopeKind: 'triggers' as const,
      triggers: [
        { group: 'g', name: 't' },
        { group: '', name: 'x' },
      ],
    };
    const parsed = alertRuleInputSchema.safeParse(toRuleRequest(values));
    expect(parsed.success).toBe(false);
    const paths = parsed.error!.issues.map((i) => ruleFormPathOf(i.path));
    expect(paths).toEqual(expect.arrayContaining(['minutes', 'triggers.1.group']));
    expect(ruleFormPathOf(['scope', 'triggers'])).toBe('triggers');
    expect(ruleFormPathOf(['renotifyMinutes'])).toBe('renotify');
  });
});
