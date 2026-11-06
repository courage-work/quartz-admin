/*
 * Ported from org.quartz.impl.triggers.CronTriggerImpl (Quartz Scheduler 2.3.2),
 * Copyright Terracotta, Inc., licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Modifications copyright (c) 2026 courage-work.
 */
import { type CronSchedule, cronSchedule } from '../cron/schedule.js';
import { TriggerSpecError } from './errors.js';

export interface CronTriggerSpec {
  cronExpression: string;
  /** `CRON_TRIGGERS.TIME_ZONE_ID`(Java ID) */
  timeZoneId: string;
  /** `TRIGGERS.START_TIME`(epoch ms) */
  startTime: number;
  /** `TRIGGERS.END_TIME`. 없으면 null */
  endTime?: number | null;
}

/**
 * `CronTriggerImpl`의 시각 계산. 캘린더(제외 시간)는 다루지 않는다(TRD §7.6, 캘린더가 연결된 트리거는 수정 거부).
 */
export class CronTriggerCalc {
  readonly schedule: CronSchedule;
  /** 밀리초를 버린 시작 시각(`setStartTime`) */
  readonly startTime: number;
  readonly endTime: number | null;

  /**
   * @throws CronValidationError, UnsupportedTimeZoneError, TriggerSpecError
   */
  constructor(spec: CronTriggerSpec) {
    this.schedule = cronSchedule(spec.cronExpression, spec.timeZoneId);
    this.startTime = Math.floor(spec.startTime / 1000) * 1000;
    this.endTime = spec.endTime ?? null;
    if (this.endTime !== null && this.startTime > this.endTime) {
      throw new TriggerSpecError('END_BEFORE_START', '종료 시각이 시작 시각보다 앞섭니다');
    }
  }

  /** `getFireTimeAfter`: 시작 시각 전이면 시작 시각부터, 종료 시각을 넘으면 null */
  fireTimeAfter(afterMs: number): number | null {
    let after = afterMs;
    if (this.startTime > after) after = this.startTime - 1000;
    if (this.endTime !== null && after >= this.endTime) return null;
    const pot = this.schedule.next(after);
    if (this.endTime !== null && pot !== null && pot > this.endTime) return null;
    return pot;
  }

  /** `computeFirstFireTime(null)`: 시작 시각 1초 전 이후 첫 시각 */
  firstFireTime(): number | null {
    return this.fireTimeAfter(this.startTime - 1000);
  }
}
