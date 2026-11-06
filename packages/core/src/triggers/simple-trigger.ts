/*
 * Ported from org.quartz.impl.triggers.SimpleTriggerImpl (Quartz Scheduler 2.3.2),
 * Copyright Terracotta, Inc., licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Modifications copyright (c) 2026 courage-work.
 */
import { TriggerSpecError } from './errors.js';

/** `SimpleTrigger.REPEAT_INDEFINITELY` */
export const REPEAT_INDEFINITELY = -1;

export interface SimpleTriggerSpec {
  /** `TRIGGERS.START_TIME` */
  startTime: number;
  endTime?: number | null;
  /** `SIMPLE_TRIGGERS.REPEAT_COUNT`. -1은 무한 */
  repeatCount: number;
  /** `SIMPLE_TRIGGERS.REPEAT_INTERVAL`(ms) */
  repeatInterval: number;
  /** `SIMPLE_TRIGGERS.TIMES_TRIGGERED` */
  timesTriggered?: number;
}

/** `SimpleTriggerImpl`의 시각 계산과 검증 */
export class SimpleTriggerCalc {
  readonly startTime: number;
  readonly endTime: number | null;
  readonly repeatCount: number;
  readonly repeatInterval: number;
  readonly timesTriggered: number;

  /** @throws TriggerSpecError Quartz가 거부하는 값 */
  constructor(spec: SimpleTriggerSpec) {
    this.startTime = spec.startTime;
    this.endTime = spec.endTime ?? null;
    if (this.endTime !== null && this.startTime > this.endTime) {
      throw new TriggerSpecError('END_BEFORE_START', '종료 시각이 시작 시각보다 앞섭니다');
    }
    if (spec.repeatCount < 0 && spec.repeatCount !== REPEAT_INDEFINITELY) {
      throw new TriggerSpecError(
        'NEGATIVE_REPEAT_COUNT',
        '반복 횟수는 0 이상이거나 -1(무한)이어야 합니다',
      );
    }
    if (spec.repeatInterval < 0) {
      throw new TriggerSpecError('NEGATIVE_REPEAT_INTERVAL', '반복 간격은 0 이상이어야 합니다');
    }
    if (spec.repeatCount !== 0 && spec.repeatInterval < 1) {
      throw new TriggerSpecError(
        'ZERO_REPEAT_INTERVAL',
        '반복하려면 반복 간격이 1ms 이상이어야 합니다',
      );
    }
    this.repeatCount = spec.repeatCount;
    this.repeatInterval = spec.repeatInterval;
    this.timesTriggered = spec.timesTriggered ?? 0;
  }

  /** `getFireTimeAfter` */
  fireTimeAfter(afterMs: number): number | null {
    if (this.timesTriggered > this.repeatCount && this.repeatCount !== REPEAT_INDEFINITELY)
      return null;
    if (this.repeatCount === 0 && afterMs >= this.startTime) return null;
    const endMillis = this.endTime ?? Number.MAX_SAFE_INTEGER;
    if (endMillis <= afterMs) return null;
    if (afterMs < this.startTime) return this.startTime;
    const numberOfTimesExecuted = Math.floor((afterMs - this.startTime) / this.repeatInterval) + 1;
    if (numberOfTimesExecuted > this.repeatCount && this.repeatCount !== REPEAT_INDEFINITELY)
      return null;
    const time = this.startTime + numberOfTimesExecuted * this.repeatInterval;
    if (endMillis <= time) return null;
    return time;
  }

  /** `computeFirstFireTime(null)`: 시작 시각 */
  firstFireTime(): number {
    return this.startTime;
  }
}
