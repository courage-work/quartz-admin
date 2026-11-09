import type { QuartzCommand } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import {
  canPauseTrigger,
  commandConfirmLabel,
  commandResultMessage,
  commandTitle,
  controlBlockedReason,
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
