import { describe, expect, it } from 'vitest';
import { isTriggerState } from './states.js';

describe('isTriggerState', () => {
  it('Quartz 트리거 상태 문자열을 인식한다', () => {
    expect(isTriggerState('WAITING')).toBe(true);
    expect(isTriggerState('PAUSED_BLOCKED')).toBe(true);
  });

  it('대소문자가 다르거나 알 수 없는 값은 거부한다', () => {
    expect(isTriggerState('waiting')).toBe(false);
    expect(isTriggerState('RUNNING')).toBe(false);
    expect(isTriggerState(null)).toBe(false);
  });
});
