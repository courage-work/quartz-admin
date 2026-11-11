import { AUDIT_ACTIONS } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import {
  auditQuery,
  describeActor,
  describeTarget,
  EMPTY_AUDIT_FILTER,
  isCodeTarget,
  recentDays,
} from './audit';
import { AUDIT_ACTION_LABELS, auditActionLabel } from './labels';

describe('auditQuery', () => {
  it('비어 있는 필터는 아무 조건도 넘기지 않는다', () => {
    expect(auditQuery(EMPTY_AUDIT_FILTER)).toEqual({});
  });

  it('입력값을 API 쿼리로 바꾼다', () => {
    expect(
      auditQuery({
        fromDate: '2026-11-06',
        toDate: '2026-11-06',
        action: 'auth.login',
        result: 'failure',
        username: '  Ghost ',
      }),
    ).toEqual({
      from: Date.UTC(2026, 10, 5, 15),
      to: Date.UTC(2026, 10, 6, 15),
      action: 'auth.login',
      result: 'failure',
      username: 'ghost',
    });
  });
});

describe('recentDays', () => {
  it('오늘을 끝으로 하는 최근 n일을 사용자 타임존 날짜로 돌려준다', () => {
    const now = new Date(2026, 10, 10, 9, 30);
    expect(recentDays(1, now)).toEqual({ fromDate: '2026-11-10', toDate: '2026-11-10' });
    expect(recentDays(7, now)).toEqual({ fromDate: '2026-11-04', toDate: '2026-11-10' });
    expect(recentDays(30, now)).toEqual({ fromDate: '2026-10-12', toDate: '2026-11-10' });
  });

  it('달과 해를 넘어간다', () => {
    expect(recentDays(7, new Date(2026, 2, 3))).toEqual({
      fromDate: '2026-02-25',
      toDate: '2026-03-03',
    });
    expect(recentDays(7, new Date(2027, 0, 2, 23, 59))).toEqual({
      fromDate: '2026-12-27',
      toDate: '2027-01-02',
    });
  });
});

describe('isCodeTarget', () => {
  it('아이디와 트리거 키만 식별자로 본다', () => {
    expect(describeTarget({ targetType: 'alert_rule', target: { id: 3, type: 'OVERDUE' } })).toBe(
      '실행 지연 규칙',
    );
    expect(isCodeTarget({ targetType: 'user' })).toBe(true);
    expect(isCodeTarget({ targetType: 'trigger' })).toBe(true);
    expect(isCodeTarget({ targetType: 'connection' })).toBe(false);
    expect(isCodeTarget({ targetType: 'scheduler' })).toBe(false);
    expect(isCodeTarget({ targetType: null })).toBe(false);
  });
});

describe('describeTarget, describeActor', () => {
  it('사용자 대상은 아이디, 없으면 #id로 보여 준다', () => {
    expect(describeTarget({ targetType: 'user', target: { id: 3, username: 'alice' } })).toBe(
      'alice',
    );
    expect(describeTarget({ targetType: 'user', target: { id: 3, username: null } })).toBe('#3');
    expect(describeTarget({ targetType: null, target: null })).toBe('-');
  });

  it('트리거 대상은 그룹 / 이름으로 보여 준다', () => {
    expect(
      describeTarget({
        targetType: 'trigger',
        target: { schedName: 'S', trigger: { group: 'g', name: 'nightly' } },
      }),
    ).toBe('g / nightly');
  });

  it('작업자가 없으면 시스템 작업이다', () => {
    expect(describeActor({ username: 'admin', userId: 1 })).toBe('admin');
    expect(describeActor({ username: null, userId: null })).toBe('시스템');
    expect(describeActor({ username: null, userId: 7 })).toBe('#7');
  });
});

describe('작업 종류 라벨', () => {
  it('모든 작업 종류에 한국어 라벨이 있다', () => {
    for (const action of AUDIT_ACTIONS) expect(AUDIT_ACTION_LABELS[action]).toMatch(/[가-힣]/);
  });

  it('모르는 작업 종류는 원래 값을 보여 준다', () => {
    expect(auditActionLabel('alert.ack')).toBe('alert.ack');
  });
});
