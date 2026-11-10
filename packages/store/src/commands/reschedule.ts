import {
  CronTriggerCalc,
  CronValidationError,
  SimpleTriggerCalc,
  TriggerSpecError,
  UnsupportedTimeZoneError,
  resolveJavaTimeZone,
  validateCron,
} from '@qa/core';
import type {
  CommandChangeDto,
  CommandGroupChangeDto,
  CommandNoticeDto,
  ScheduleSnapshotDto,
  TriggerDto,
  UpdateCronScheduleCommand,
  UpdateSimpleScheduleCommand,
} from '@qa/shared';
import type { TargetConn } from '../adapter.js';
import { ALL_GROUPS_PAUSED, getTriggerDetail } from '../views/views.js';
import { triggerWhere } from './pause-resume.js';
import {
  jobKeyOf,
  selectBlockingJobs,
  selectPausedGroups,
  selectTriggerTargets,
} from './triggers.js';
import {
  CommandRejection,
  type CommandHandler,
  type CommandPlan,
  type CommandSubject,
  type SchedulerCommandContext,
} from './types.js';

/*
 * 스케줄 수정 (FR-CTL-06, FR-CTL-07, TRD §7.6, 부록 A.6).
 * Quartz `rescheduleJob`처럼 트리거를 지우고 다시 넣지 않고, 기존 행의 스케줄 값과 시각만 UPDATE한다.
 * 키, 잡, DESCRIPTION, PRIORITY, MISFIRE_INSTR, CALENDAR_NAME, JOB_DATA, END_TIME, PREV_FIRE_TIME은 그대로다.
 */

/** 확인 대화상자에 보여 줄 다음 실행 시각 수 */
const UPCOMING = 5;

/**
 * 노드가 트리거를 미리 집는 범위(Quartz `org.quartz.scheduler.idleWaitTime` 기본값 30초)에 시계 차이와 처리 시간 여유 5초를 더한 값.
 * 집힌(ACQUIRED) 트리거를 고칠 때 새 스케줄의 실행 시각이 옛 발화 시각부터 이만큼 안에 있으면 거부한다(TRD §7.6 "집힌 트리거")
 */
export const ACQUIRED_RACE_WINDOW_MS = 35_000;

/** 대상 트리거와 그 스케줄, 상태 결정에 필요한 그룹 일시정지·실행 중인 잡을 읽는다 */
async function readScheduleSubject(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  key: { group: string; name: string },
  lockWaitSec: number | undefined,
): Promise<CommandSubject> {
  const triggers = await selectTriggerTargets(
    conn,
    ctx,
    triggerWhere(key.group, key.name),
    lockWaitSec,
  );
  const detail = triggers.length > 0 ? await getTriggerDetail(conn, ctx, key) : null;
  if (!detail) throw new CommandRejection('NOT_FOUND', '트리거를 찾을 수 없습니다');
  return {
    triggers,
    pausedGroups: await selectPausedGroups(conn, ctx, [key.group, ALL_GROUPS_PAUSED]),
    blockingJobs: await selectBlockingJobs(conn, ctx),
    detail,
  };
}

function reject(notice: CommandNoticeDto): CommandPlan {
  return {
    changes: [],
    groupChanges: [],
    inserts: [],
    scheduleChanges: [],
    warnings: [],
    rejection: notice,
  };
}

const invalid = (message: string) => reject({ code: 'INVALID_SCHEDULE', message });

/** 수정할 수 없는 트리거인지. COMPLETE, 캘린더 연결, 종류가 다른 트리거는 거부한다 */
function precheck(detail: TriggerDto, kind: 'CRON' | 'SIMPLE'): CommandPlan | null {
  if (detail.state === 'COMPLETE') {
    return reject({
      code: 'TRIGGER_COMPLETE',
      message: '실행을 마쳐 곧 삭제될 트리거(COMPLETE)라 스케줄을 수정할 수 없습니다',
    });
  }
  if (detail.calendarName) {
    return reject({
      code: 'CALENDAR_ATTACHED',
      message: `캘린더(${detail.calendarName})가 연결된 트리거는 스케줄을 수정할 수 없습니다. 캘린더의 제외 시간을 계산할 수 없기 때문입니다`,
    });
  }
  const matches = kind === 'CRON' ? detail.cron !== null : detail.simple !== null;
  if (detail.type !== kind || !matches) {
    return reject({
      code: 'TRIGGER_TYPE_MISMATCH',
      message: `${kind} 트리거가 아니라 수정할 수 없습니다(이 트리거는 ${detail.type})`,
    });
  }
  return null;
}

interface StateDecision {
  state: string;
  groupChanges: CommandGroupChangeDto[];
  warnings: CommandNoticeDto[];
}

/**
 * 수정 뒤 상태 (TRD §7.6 "상태 결정"). Quartz `replaceTrigger`의 저장 규칙을 따르되 개별 일시정지만 유지한다.
 * 1. 지금 PAUSED·PAUSED_BLOCKED면 기준 상태 PAUSED, 아니면 WAITING
 * 2. 기준 상태가 WAITING이면 그룹 규칙: 그룹이 일시정지면 PAUSED, 전체 일시정지만 있으면 그룹 행을 넣고 PAUSED
 * 3. 같은 잡이 동시 실행 금지로 실행 중이면 BLOCKED(PAUSED면 PAUSED_BLOCKED)
 * 그래서 ACQUIRED는 WAITING이 된다. 노드가 메모리의 옛 트리거로 행을 덮어쓰지 않게 하는 규칙이다(§7.2).
 */
function decideState(subject: CommandSubject, detail: TriggerDto): StateDecision {
  const current = subject.triggers[0]?.state ?? detail.state;
  const individuallyPaused = current === 'PAUSED' || current === 'PAUSED_BLOCKED';
  let base = individuallyPaused ? 'PAUSED' : 'WAITING';
  const groupChanges: CommandGroupChangeDto[] = [];
  if (base === 'WAITING') {
    const groupPaused = subject.pausedGroups.includes(detail.group);
    const allPaused = subject.pausedGroups.includes(ALL_GROUPS_PAUSED);
    if (groupPaused || allPaused) {
      base = 'PAUSED';
      if (!groupPaused) groupChanges.push({ group: detail.group, paused: true });
    }
  }
  const blocking = subject.blockingJobs.has(jobKeyOf(detail.jobGroup, detail.jobName));
  const state = blocking ? (base === 'PAUSED' ? 'PAUSED_BLOCKED' : 'BLOCKED') : base;

  const warnings: CommandNoticeDto[] = [];
  if (current === 'ERROR') {
    warnings.push({ code: 'ERROR_CLEARED', message: '오류(ERROR) 상태가 풀려 다시 실행됩니다' });
  }
  if (individuallyPaused) {
    warnings.push({
      code: 'PAUSE_KEPT',
      message:
        '일시정지된 트리거라 수정 뒤에도 일시정지 상태를 유지합니다. 실행하려면 재개하세요(Quartz rescheduleJob은 일시정지를 풉니다)',
    });
  }
  return { state, groupChanges, warnings };
}

/**
 * 집힌(ACQUIRED) 트리거를 경합이 나는 시각으로 고치는지 (TRD §7.6 "집힌 트리거").
 *
 * 트리거를 집은 노드는 옛 발화 시각 F에 상태가 ACQUIRED인지만 보고(`JSS.triggerFired`) 메모리의 옛 트리거로 발화한 뒤
 * 행을 덮어쓴다. 도구가 상태를 WAITING으로 되돌려도, 새 스케줄의 실행 시각이 F 직후면 다른 노드가 F 전에 새 스케줄로
 * 다시 집어 ACQUIRED로 만들 수 있고, 그러면 옛 스케줄로 실행되고 수정이 사라진다. 그래서 F 이후 첫 새 실행 시각이
 * F + `ACQUIRED_RACE_WINDOW_MS`보다 이르면 거부한다. Quartz `rescheduleJob`에도 같은 경합이 있다.
 *
 * @param nextAtOrAfter `t` 이상인 첫 새 실행 시각
 */
function acquiredRace(
  subject: CommandSubject,
  detail: TriggerDto,
  nextAtOrAfter: (t: number) => number | null,
): CommandPlan | null {
  const current = subject.triggers[0]?.state ?? detail.state;
  const oldFire = detail.nextFireTime;
  if (current !== 'ACQUIRED' || oldFire === null) return null;
  const next = nextAtOrAfter(oldFire);
  if (next === null || next >= oldFire + ACQUIRED_RACE_WINDOW_MS) return null;
  return reject({
    code: 'TRIGGER_ACQUIRED',
    message:
      'Quartz 노드가 곧 실행하려고 집은 트리거인데, 새 스케줄의 실행 시각이 그 직후라 다른 노드가 먼저 집으면 ' +
      '옛 스케줄로 실행되고 수정이 되돌아갈 수 있습니다. 예정된 실행이 지난 뒤 다시 시도하거나, ' +
      '트리거를 일시정지한 뒤 수정하고 재개하세요',
  });
}

/** 상태 결정과 스케줄 변경을 계획으로 묶는다 */
function schedulePlan(
  subject: CommandSubject,
  detail: TriggerDto,
  from: ScheduleSnapshotDto,
  to: ScheduleSnapshotDto,
  upcoming: number[],
): CommandPlan {
  const current = subject.triggers[0]?.state ?? detail.state;
  const decision = decideState(subject, detail);
  const changes: CommandChangeDto[] =
    decision.state === current
      ? []
      : [{ group: detail.group, name: detail.name, from: current, to: decision.state }];
  return {
    changes,
    groupChanges: decision.groupChanges,
    inserts: [],
    scheduleChanges: [
      { group: detail.group, name: detail.name, from, to, upcoming, state: current },
    ],
    warnings: decision.warnings,
    rejection: null,
  };
}

/** `after` 다음 실행 시각을 `count`개까지 모은다 */
function collect(first: number | null, next: (t: number) => number | null, count: number) {
  const out: number[] = [];
  for (let t = first; t !== null && out.length < count; t = next(t)) out.push(t);
  return out;
}

/**
 * CRON 스케줄 수정 (FR-CTL-06). CRON_EXPRESSION과 TIME_ZONE_ID를 바꾸고 NEXT_FIRE_TIME을
 * `getFireTimeAfter(max(dbNow, START_TIME - 1000))`로 다시 계산한다(END_TIME 반영). START_TIME은 그대로다.
 * 식은 Quartz `CronExpression`처럼 대문자로 저장한다.
 */
export const updateCronScheduleHandler: CommandHandler<UpdateCronScheduleCommand> = {
  type: 'updateCronSchedule',

  readSubject(conn, ctx, command, lockWaitSec) {
    return readScheduleSubject(conn, ctx, command.trigger, lockWaitSec);
  },

  plan(command, subject, { dbNow }) {
    const detail = subject.detail;
    if (!detail) throw new CommandRejection('NOT_FOUND', '트리거를 찾을 수 없습니다');
    const blocked = precheck(detail, 'CRON');
    if (blocked) return blocked;

    const expression = command.cronExpression.trim().toUpperCase();
    const validation = validateCron(expression);
    if (!validation.ok) return invalid(validation.error.message);
    let calc: CronTriggerCalc;
    let timeZone: string;
    try {
      // Java는 모르는 ID를 GMT로 바꿔 조용히 저장한다. 오타를 막도록 도구는 거부한다(의도된 차이)
      const zone = resolveJavaTimeZone(command.timeZone);
      if (zone.fallbackToGmt) return invalid(`알 수 없는 타임존입니다: ${command.timeZone}`);
      timeZone = zone.javaId;
      calc = new CronTriggerCalc({
        cronExpression: expression,
        timeZoneId: command.timeZone,
        startTime: detail.startTime ?? dbNow,
        endTime: detail.endTime,
      });
    } catch (err) {
      if (err instanceof UnsupportedTimeZoneError) {
        return invalid(`지원하지 않는 타임존입니다: ${command.timeZone}`);
      }
      if (err instanceof CronValidationError || err instanceof TriggerSpecError) {
        return invalid(err.message);
      }
      throw err;
    }
    // fireTimeAfter는 시작 시각 전이면 START_TIME - 1000부터 계산한다(`CronTriggerImpl.getFireTimeAfter`)
    const nextFireTime = calc.fireTimeAfter(dbNow);
    if (nextFireTime === null) {
      return invalid(
        '이 스케줄로는 더 이상 실행되지 않습니다. 종료 시각이 지났거나 남은 실행 시각이 없습니다',
      );
    }
    const race = acquiredRace(subject, detail, (t) => calc.fireTimeAfter(t - 1));
    if (race) return race;
    const cron = detail.cron!;
    return schedulePlan(
      subject,
      detail,
      {
        kind: 'CRON',
        cronExpression: cron.expression,
        timeZone: cron.timeZone,
        startTime: detail.startTime,
        nextFireTime: detail.nextFireTime,
      },
      {
        kind: 'CRON',
        cronExpression: expression,
        timeZone,
        startTime: detail.startTime,
        nextFireTime,
      },
      collect(nextFireTime, (t) => calc.fireTimeAfter(t), UPCOMING),
    );
  },
};

/**
 * SIMPLE 스케줄 수정 (FR-CTL-07). REPEAT_INTERVAL과 REPEAT_COUNT를 바꾸고 TIMES_TRIGGERED=0,
 * START_TIME = NEXT_FIRE_TIME = `startAt`(기본은 대상 DB 현재 시각)으로 둔다. "지금부터 새 간격으로 다시 시작"한다.
 * 검증은 Quartz와 같다(`SimpleTriggerImpl.validate`, 종료 시각). 지난 `startAt`은 넣자마자 misfire가 되므로 거부한다.
 */
export const updateSimpleScheduleHandler: CommandHandler<UpdateSimpleScheduleCommand> = {
  type: 'updateSimpleSchedule',

  readSubject(conn, ctx, command, lockWaitSec) {
    return readScheduleSubject(conn, ctx, command.trigger, lockWaitSec);
  },

  plan(command, subject, { dbNow }) {
    const detail = subject.detail;
    if (!detail) throw new CommandRejection('NOT_FOUND', '트리거를 찾을 수 없습니다');
    const blocked = precheck(detail, 'SIMPLE');
    if (blocked) return blocked;

    if (command.startAt !== undefined && command.startAt < dbNow) {
      return invalid(
        '시작 시각이 이미 지났습니다. 지금 이후 시각을 고르거나 비워 두세요(지금부터 시작)',
      );
    }
    const startAt = command.startAt ?? dbNow;
    let calc: SimpleTriggerCalc;
    try {
      calc = new SimpleTriggerCalc({
        startTime: startAt,
        endTime: detail.endTime,
        repeatCount: command.repeatCount,
        repeatInterval: command.repeatIntervalMs,
      });
    } catch (err) {
      if (err instanceof TriggerSpecError) return invalid(err.message);
      throw err;
    }
    const race = acquiredRace(subject, detail, (t) => calc.fireTimeAfter(t - 1));
    if (race) return race;
    const simple = detail.simple!;
    return schedulePlan(
      subject,
      detail,
      {
        kind: 'SIMPLE',
        repeatIntervalMs: simple.repeatIntervalMs,
        repeatCount: simple.repeatCount,
        timesTriggered: simple.timesTriggered,
        startTime: detail.startTime,
        nextFireTime: detail.nextFireTime,
      },
      {
        kind: 'SIMPLE',
        repeatIntervalMs: command.repeatIntervalMs,
        repeatCount: command.repeatCount,
        timesTriggered: 0,
        startTime: startAt,
        nextFireTime: startAt,
      },
      collect(startAt, (t) => calc.fireTimeAfter(t), UPCOMING),
    );
  },
};
