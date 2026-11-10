import type { QuartzCommand } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import {
  canPauseTrigger,
  canResumeTrigger,
  commandConfirmLabel,
  commandResultMessage,
  commandTitle,
  controlBlockedReason,
  summarizeChanges,
} from './commands';

const PAUSE: QuartzCommand = { type: 'pauseTrigger', trigger: { group: 'g', name: 'nightly' } };

describe('제어 명령 문구', () => {
  it('제목과 동사로 시작하는 실행 버튼 문구', () => {
    expect(commandTitle(PAUSE)).toBe('트리거 일시정지');
    expect(commandConfirmLabel(PAUSE)).toBe('일시정지하기');
  });

  it('바뀐 것이 없으면 그렇다고 알린다', () => {
    expect(commandResultMessage({ command: PAUSE, changed: true })).toBe(
      'nightly 트리거를 일시정지했습니다',
    );
    expect(commandResultMessage({ command: PAUSE, changed: false })).toMatch(/바뀐 것이 없습니다/);
  });
});

describe('재개·잡·그룹 문구', () => {
  const RESUME_JOB: QuartzCommand = { type: 'resumeJob', job: { group: 'jg', name: 'report' } };

  it('대상에 맞는 조사를 붙인다', () => {
    expect(commandResultMessage({ command: RESUME_JOB, changed: true })).toBe(
      'report 잡을 재개했습니다',
    );
    expect(
      commandResultMessage({ command: { type: 'pauseTriggerGroup', group: 'g' }, changed: false }),
    ).toMatch(/^g 트리거 그룹은 바뀐 것이 없습니다/);
    expect(commandTitle({ type: 'resumeJobGroup', group: 'jg' })).toBe('잡 그룹 재개');
    expect(commandConfirmLabel(RESUME_JOB)).toBe('재개하기');
  });

  it('지난 실행이 있으면 misfire 처리 안내를 붙인다 (TRD §7.4)', () => {
    expect(
      commandResultMessage({
        command: RESUME_JOB,
        changed: true,
        warnings: [{ code: 'MISFIRE_DELEGATED', message: '' }],
      }),
    ).toMatch(/misfire 정책에 따라 최대 1분/);
  });

  it('상태 변경을 전·후 상태로 묶어 센다', () => {
    expect(
      summarizeChanges([
        { group: 'g', name: 'a', from: 'WAITING', to: 'PAUSED' },
        { group: 'g', name: 'b', from: 'BLOCKED', to: 'PAUSED_BLOCKED' },
        { group: 'g', name: 'c', from: 'WAITING', to: 'PAUSED' },
      ]),
    ).toEqual([
      { from: 'WAITING', to: 'PAUSED', count: 2 },
      { from: 'BLOCKED', to: 'PAUSED_BLOCKED', count: 1 },
    ]);
  });
});

describe('즉시 실행 문구 (TRD §7.5)', () => {
  const TRIGGER: QuartzCommand = { type: 'triggerJob', job: { group: 'jg', name: 'report' } };
  const ins = (state: string) => [
    {
      group: 'DEFAULT',
      name: 'MT_1',
      jobGroup: 'jg',
      jobName: 'report',
      state,
      startTime: 0,
      description: '',
    },
  ];

  it('넣은 트리거 상태에 따라 언제 실행되는지 알린다', () => {
    expect(commandTitle(TRIGGER)).toBe('잡 즉시 실행');
    expect(commandConfirmLabel(TRIGGER)).toBe('실행하기');
    expect(commandResultMessage({ command: TRIGGER, changed: true, inserts: ins('WAITING') })).toBe(
      'report 잡을 즉시 실행으로 걸었습니다. Quartz 노드가 다음 확인 때(기본 최대 30초) 실행합니다',
    );
    expect(
      commandResultMessage({ command: TRIGGER, changed: true, inserts: ins('BLOCKED') }),
    ).toMatch(/실행 중인 잡이 끝난 뒤/);
    expect(
      commandResultMessage({ command: TRIGGER, changed: true, inserts: ins('PAUSED') }),
    ).toMatch(/재개해야 실행됩니다/);
  });
});

describe('canResumeTrigger', () => {
  it('PAUSED, PAUSED_BLOCKED만 재개할 수 있다', () => {
    expect(['PAUSED', 'PAUSED_BLOCKED'].every(canResumeTrigger)).toBe(true);
    expect(['WAITING', 'BLOCKED', 'ERROR', 'COMPLETE'].some(canResumeTrigger)).toBe(false);
  });
});

describe('canPauseTrigger', () => {
  it('WAITING, ACQUIRED, BLOCKED만 일시정지할 수 있다', () => {
    expect(['WAITING', 'ACQUIRED', 'BLOCKED'].every(canPauseTrigger)).toBe(true);
    expect(['PAUSED', 'PAUSED_BLOCKED', 'ERROR', 'COMPLETE', 'x'].some(canPauseTrigger)).toBe(
      false,
    );
  });
});

describe('controlBlockedReason (FR-CTL-00a)', () => {
  it('읽기 전용이거나 쓰기 권한이 확인되지 않으면 이유를 돌려준다', () => {
    expect(controlBlockedReason({ readOnly: false, writeCapable: true })).toBeNull();
    expect(controlBlockedReason({ readOnly: true, writeCapable: true })).toMatch(/읽기 전용/);
    expect(controlBlockedReason({ readOnly: false, writeCapable: false })).toMatch(/권한이 없어/);
    expect(controlBlockedReason({ readOnly: false, writeCapable: null })).toMatch(/확인하지 않아/);
  });
});
