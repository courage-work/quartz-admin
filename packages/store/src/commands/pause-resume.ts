import {
  COMMAND_TARGETS_LISTED,
  COMMAND_TARGETS_MAX,
  type CommandNoticeDto,
  type PauseAllCommand,
  type ResumeAllCommand,
} from '@qa/shared';
import type {
  PauseJobCommand,
  PauseJobGroupCommand,
  PauseTriggerCommand,
  PauseTriggerGroupCommand,
  ResumeJobCommand,
  ResumeJobGroupCommand,
  ResumeTriggerCommand,
  ResumeTriggerGroupCommand,
} from '@qa/shared';
import type { TargetConn } from '../adapter.js';
import type { Binds } from '../views/sql.js';
import { ALL_GROUPS_PAUSED, listPausedGroups } from '../views/views.js';
import {
  jobExists,
  noChangeWarning,
  pauseChanges,
  resumeChanges,
  resumePlanOf,
  selectBlockingJobs,
  selectPausedGroups,
  selectTriggerTargets,
} from './triggers.js';
import {
  CommandRejection,
  type CommandHandler,
  type CommandSubject,
  type CommandTarget,
  type SchedulerCommandContext,
} from './types.js';

/*
 * 일시정지와 재개 (FR-CTL-01~04·11, TRD §7.3·§7.4, 부록 A.2~A.4).
 * 트리거·잡·트리거 그룹·잡 그룹·스케줄러 전체 다섯 단위가 같은 상태 전이를 쓰고, 대상을 고르는 조건과
 * `PAUSED_TRIGGER_GRPS`를 다루는 방식만 다르다.
 */

type Where = (b: Binds) => string;

const NO_JOBS: ReadonlySet<string> = new Set();

export const triggerWhere =
  (group: string, name: string): Where =>
  (b) =>
    `t.TRIGGER_GROUP = ${b.add(group)} AND t.TRIGGER_NAME = ${b.add(name)}`;

export const jobWhere =
  (alias: 't' | 'j', group: string, name: string): Where =>
  (b) =>
    `${alias}.JOB_GROUP = ${b.add(group)} AND ${alias}.JOB_NAME = ${b.add(name)}`;

const triggerGroupWhere =
  (group: string): Where =>
  (b) =>
    `t.TRIGGER_GROUP = ${b.add(group)}`;

const jobGroupWhere =
  (alias: 't' | 'j', group: string): Where =>
  (b) =>
    `${alias}.JOB_GROUP = ${b.add(group)}`;

/** 트리거 하나. 없으면 `NOT_FOUND` */
async function readTrigger(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  key: { group: string; name: string },
  lockWaitSec: number | undefined,
): Promise<CommandTarget[]> {
  const targets = await selectTriggerTargets(
    conn,
    ctx,
    triggerWhere(key.group, key.name),
    lockWaitSec,
  );
  if (targets.length === 0) throw new CommandRejection('NOT_FOUND', '트리거를 찾을 수 없습니다');
  return targets;
}

/** 잡의 트리거. 트리거가 없는 잡이면 빈 목록이고, 잡이 없으면 `NOT_FOUND` */
async function readJobTriggers(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  key: { group: string; name: string },
  lockWaitSec: number | undefined,
): Promise<CommandTarget[]> {
  const targets = await selectTriggerTargets(
    conn,
    ctx,
    jobWhere('t', key.group, key.name),
    lockWaitSec,
  );
  if (targets.length === 0 && !(await jobExists(conn, ctx, jobWhere('j', key.group, key.name)))) {
    throw new CommandRejection('NOT_FOUND', '잡을 찾을 수 없습니다');
  }
  return targets;
}

/** 잡 그룹의 트리거. 그룹에 잡이 하나도 없으면 `NOT_FOUND` */
async function readJobGroupTriggers(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  group: string,
  lockWaitSec: number | undefined,
): Promise<CommandTarget[]> {
  const targets = await selectTriggerTargets(conn, ctx, jobGroupWhere('t', group), lockWaitSec);
  if (targets.length === 0 && !(await jobExists(conn, ctx, jobGroupWhere('j', group)))) {
    throw new CommandRejection('NOT_FOUND', '잡 그룹을 찾을 수 없습니다');
  }
  return targets;
}

/** 일시정지 명령의 대상. 그룹 일시정지 여부는 결과에 영향이 없어 읽지 않는다 */
const pauseSubject = (triggers: CommandTarget[]): CommandSubject => ({
  triggers,
  pausedGroups: [],
  blockingJobs: NO_JOBS,
});

/** 재개 명령의 대상. 대상 그룹과 전체 일시정지 표시, 동시 실행 금지로 실행 중인 잡을 함께 읽는다 */
async function resumeSubject(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  triggers: CommandTarget[],
  groups: Iterable<string> = triggers.map((t) => t.group),
): Promise<CommandSubject> {
  return {
    triggers,
    pausedGroups: await selectPausedGroups(conn, ctx, [...groups, ALL_GROUPS_PAUSED]),
    blockingJobs: await selectBlockingJobs(conn, ctx),
  };
}

const singleState = (subject: CommandSubject) => subject.triggers[0]?.state ?? '';

export const pauseTriggerHandler: CommandHandler<PauseTriggerCommand> = {
  type: 'pauseTrigger',

  async readSubject(conn, ctx, command, lockWaitSec) {
    return pauseSubject(await readTrigger(conn, ctx, command.trigger, lockWaitSec));
  },

  plan(_command, subject) {
    return noChangeWarning(
      {
        changes: pauseChanges(subject.triggers),
        groupChanges: [],
        inserts: [],
        scheduleChanges: [],
        warnings: [],
        rejection: null,
      },
      `지금 상태(${singleState(subject)})에서는 일시정지해도 바뀌는 것이 없습니다`,
    );
  },
};

/**
 * 트리거 재개 (`JSS.resumeTrigger`). 트리거 그룹이 일시정지 상태인지는 보지 않는다(부록 A.3 R-09).
 * 다만 그룹 일시정지 안에서 실행 시각이 지났으면 거부한다(TRD §7.4, R-31·R-32).
 */
export const resumeTriggerHandler: CommandHandler<ResumeTriggerCommand> = {
  type: 'resumeTrigger',

  async readSubject(conn, ctx, command, lockWaitSec) {
    return resumeSubject(conn, ctx, await readTrigger(conn, ctx, command.trigger, lockWaitSec));
  },

  plan(_command, subject, { dbNow }) {
    const resume = resumeChanges(subject.triggers, {
      dbNow,
      blockingJobs: subject.blockingJobs,
      pausedAfter: new Set(subject.pausedGroups),
    });
    return noChangeWarning(
      resumePlanOf(resume, { groupChanges: [] }),
      `지금 상태(${singleState(subject)})에서는 재개해도 바뀌는 것이 없습니다`,
    );
  },
};

/** 잡 일시정지 (`JSS.pauseJob`): 잡의 모든 트리거에 `pauseTrigger` */
export const pauseJobHandler: CommandHandler<PauseJobCommand> = {
  type: 'pauseJob',

  async readSubject(conn, ctx, command, lockWaitSec) {
    return pauseSubject(await readJobTriggers(conn, ctx, command.job, lockWaitSec));
  },

  plan(_command, subject) {
    return noChangeWarning(
      {
        changes: pauseChanges(subject.triggers),
        groupChanges: [],
        inserts: [],
        scheduleChanges: [],
        warnings: [],
        rejection: null,
      },
      subject.triggers.length === 0
        ? '이 잡에는 트리거가 없어 바뀌는 것이 없습니다'
        : '이미 모두 일시정지됐거나 일시정지할 수 없는 상태라 바뀌는 것이 없습니다',
    );
  },
};

/** 잡 재개 (`JSS.resumeJob`): 잡의 모든 트리거에 `resumeTrigger`. 하나라도 거부 대상이면 전체를 거부한다(R-33) */
export const resumeJobHandler: CommandHandler<ResumeJobCommand> = {
  type: 'resumeJob',

  async readSubject(conn, ctx, command, lockWaitSec) {
    return resumeSubject(conn, ctx, await readJobTriggers(conn, ctx, command.job, lockWaitSec));
  },

  plan(_command, subject, { dbNow }) {
    const resume = resumeChanges(subject.triggers, {
      dbNow,
      blockingJobs: subject.blockingJobs,
      pausedAfter: new Set(subject.pausedGroups),
    });
    return noChangeWarning(
      resumePlanOf(resume, { groupChanges: [] }),
      subject.triggers.length === 0
        ? '이 잡에는 트리거가 없어 바뀌는 것이 없습니다'
        : '일시정지된 트리거가 없어 바뀌는 것이 없습니다',
    );
  },
};

/**
 * 트리거 그룹 일시정지 (`JSS.pauseTriggerGroup`). 그룹의 트리거를 일시정지하고, `PAUSED_TRIGGER_GRPS`에 그룹 행이
 * 없으면 넣는다. 트리거가 없는 그룹이어도 넣는다(G-02). 그룹 이름은 `=`로 비교한다(G-07, TRD §7.3).
 */
export const pauseTriggerGroupHandler: CommandHandler<PauseTriggerGroupCommand> = {
  type: 'pauseTriggerGroup',

  async readSubject(conn, ctx, command, lockWaitSec) {
    const triggers = await selectTriggerTargets(
      conn,
      ctx,
      triggerGroupWhere(command.group),
      lockWaitSec,
    );
    return {
      triggers,
      pausedGroups: await selectPausedGroups(conn, ctx, [command.group]),
      blockingJobs: NO_JOBS,
    };
  },

  plan(command, subject) {
    const groupPaused = subject.pausedGroups.includes(command.group);
    return noChangeWarning(
      {
        changes: pauseChanges(subject.triggers),
        groupChanges: groupPaused ? [] : [{ group: command.group, paused: true }],
        inserts: [],
        scheduleChanges: [],
        warnings: [],
        rejection: null,
      },
      '그룹이 이미 일시정지됐고 일시정지할 트리거도 없어 바뀌는 것이 없습니다',
    );
  },
};

/**
 * 트리거 그룹 재개 (`JSS.resumeTriggerGroup`). `PAUSED_TRIGGER_GRPS`에서 그룹 행을 지우고 그룹의 모든 트리거에
 * `resumeTrigger`를 적용한다. 개별로 일시정지한 트리거도 재개된다(G-06).
 * 전체 일시정지 표시가 남아 있으면 그룹 행을 지워도 지난 트리거는 MisfireHandler가 다시 일시정지하므로 거부한다(TRD §7.4).
 */
export const resumeTriggerGroupHandler: CommandHandler<ResumeTriggerGroupCommand> = {
  type: 'resumeTriggerGroup',

  async readSubject(conn, ctx, command, lockWaitSec) {
    const triggers = await selectTriggerTargets(
      conn,
      ctx,
      triggerGroupWhere(command.group),
      lockWaitSec,
    );
    return resumeSubject(conn, ctx, triggers, [command.group]);
  },

  plan(command, subject, { dbNow }) {
    const groupPaused = subject.pausedGroups.includes(command.group);
    const resume = resumeChanges(subject.triggers, {
      dbNow,
      blockingJobs: subject.blockingJobs,
      pausedAfter: new Set(subject.pausedGroups.filter((g) => g !== command.group)),
    });
    return noChangeWarning(
      resumePlanOf(resume, {
        groupChanges: groupPaused ? [{ group: command.group, paused: false }] : [],
      }),
      '그룹이 일시정지 상태가 아니고 일시정지된 트리거도 없어 바뀌는 것이 없습니다',
    );
  },
};

const JOB_GROUP_NOT_STORED = {
  code: 'JOB_GROUP_NOT_STORED',
  message:
    '잡 그룹 일시정지는 Quartz에 저장되지 않습니다. 지금 있는 잡의 트리거만 일시정지하고, ' +
    '나중에 이 그룹에 추가되는 잡은 일시정지되지 않습니다',
} as const;

/** 잡 그룹 일시정지 (`JSS.pauseJobs`): 그룹의 잡마다 `pauseJob`. `PAUSED_TRIGGER_GRPS`는 바꾸지 않는다(G-08) */
export const pauseJobGroupHandler: CommandHandler<PauseJobGroupCommand> = {
  type: 'pauseJobGroup',

  async readSubject(conn, ctx, command, lockWaitSec) {
    return pauseSubject(await readJobGroupTriggers(conn, ctx, command.group, lockWaitSec));
  },

  plan(_command, subject) {
    return noChangeWarning(
      {
        changes: pauseChanges(subject.triggers),
        groupChanges: [],
        inserts: [],
        scheduleChanges: [],
        warnings: [JOB_GROUP_NOT_STORED],
        rejection: null,
      },
      '이미 모두 일시정지됐거나 일시정지할 트리거가 없어 바뀌는 것이 없습니다',
    );
  },
};

/** 잡 그룹 재개 (`JSS.resumeJobs`): 그룹의 잡마다 `resumeJob`. 하나라도 거부 대상이면 전체를 거부한다 */
export const resumeJobGroupHandler: CommandHandler<ResumeJobGroupCommand> = {
  type: 'resumeJobGroup',

  async readSubject(conn, ctx, command, lockWaitSec) {
    return resumeSubject(
      conn,
      ctx,
      await readJobGroupTriggers(conn, ctx, command.group, lockWaitSec),
    );
  },

  plan(_command, subject, { dbNow }) {
    const resume = resumeChanges(subject.triggers, {
      dbNow,
      blockingJobs: subject.blockingJobs,
      pausedAfter: new Set(subject.pausedGroups),
    });
    return noChangeWarning(
      resumePlanOf(resume, { groupChanges: [] }),
      '일시정지된 트리거가 없어 바뀌는 것이 없습니다',
    );
  },
};

// ── 스케줄러 전체 (FR-CTL-11, 부록 A.4 G-11~G-13) ─────────────────────

const allTriggersWhere: Where = () => '1 = 1';

/**
 * 스케줄러의 모든 트리거와 `PAUSED_TRIGGER_GRPS`의 모든 행. 트리거가 없는 그룹의 행은 명령이 바꾸지 않지만
 * 전체 재개 뒤에도 남는다고 알리려고 함께 읽는다
 */
async function readAll(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  lockWaitSec: number | undefined,
  blocking: boolean,
): Promise<CommandSubject> {
  const triggers = await selectTriggerTargets(conn, ctx, allTriggersWhere, lockWaitSec);
  return {
    triggers,
    pausedGroups: [...new Set(await listPausedGroups(conn, ctx))].sort(),
    blockingJobs: blocking ? await selectBlockingJobs(conn, ctx) : NO_JOBS,
  };
}

/** 트리거가 있는 그룹 (`JSS.getTriggerGroupNames`: `SELECT DISTINCT TRIGGER_GROUP FROM TRIGGERS`). 이름순 */
function triggerGroupsOf(triggers: readonly CommandTarget[]): string[] {
  return [...new Set(triggers.map((t) => t.group))].sort();
}

/** 한 명령이 다루는 트리거 수 상한(`COMMAND_TARGETS_MAX`)을 넘으면 실행하지 않는다 */
function tooManyTargets(subject: CommandSubject): CommandNoticeDto | null {
  if (subject.triggers.length <= COMMAND_TARGETS_MAX) return null;
  return {
    code: 'TOO_MANY_TARGETS',
    message:
      `트리거가 ${subject.triggers.length.toLocaleString('ko-KR')}개라 한 번에 다룰 수 있는 ` +
      `${COMMAND_TARGETS_MAX.toLocaleString('ko-KR')}개를 넘습니다. 트리거 그룹별로 나눠 실행하세요`,
  };
}

/** 트리거가 없는 그룹의 일시정지 기록은 `resumeAll` 뒤에도 남는다(G-13). 그 그룹에 트리거를 추가하면 일시정지된 채로 시작한다 */
function pausedGroupsKept(groups: readonly string[]): CommandNoticeDto {
  const listed = groups.slice(0, COMMAND_TARGETS_LISTED);
  const more = groups.length - listed.length;
  return {
    code: 'PAUSED_GROUPS_KEPT',
    message:
      `트리거가 없는 그룹 ${groups.length}개(${listed.join(', ')}${more > 0 ? ` 외 ${more}개` : ''})의 ` +
      '일시정지 기록은 Quartz와 같이 그대로 남습니다. 이 그룹에 트리거를 추가하면 일시정지된 채로 시작합니다',
  };
}

const rejected = (rejection: CommandNoticeDto) => ({
  changes: [],
  groupChanges: [],
  inserts: [],
  scheduleChanges: [],
  warnings: [],
  rejection,
});

/**
 * 스케줄러 전체 일시정지 (`JSS.pauseAll`). 트리거가 있는 그룹마다 `pauseTriggerGroup`을 하고(그룹 행이 없으면 넣음),
 * 전체 일시정지 표시가 없으면 넣는다. 트리거가 없는 스케줄러여도 표시는 넣는다(G-11).
 */
export const pauseAllHandler: CommandHandler<PauseAllCommand> = {
  type: 'pauseAll',

  async readSubject(conn, ctx, _command, lockWaitSec) {
    return readAll(conn, ctx, lockWaitSec, false);
  },

  plan(_command, subject) {
    const tooMany = tooManyTargets(subject);
    if (tooMany) return rejected(tooMany);
    const paused = new Set(subject.pausedGroups);
    const groups = [...triggerGroupsOf(subject.triggers), ALL_GROUPS_PAUSED];
    return noChangeWarning(
      {
        changes: pauseChanges(subject.triggers),
        groupChanges: groups
          .filter((g) => !paused.has(g))
          .map((group) => ({ group, paused: true })),
        inserts: [],
        scheduleChanges: [],
        warnings: [],
        rejection: null,
      },
      '이미 전체 일시정지 상태이고 일시정지할 트리거도 없어 바뀌는 것이 없습니다',
    );
  },
};

/**
 * 스케줄러 전체 재개 (`JSS.resumeAll`). 트리거가 있는 그룹마다 `resumeTriggerGroup`을 하고(그룹 행을 지우고 트리거 재개),
 * 전체 일시정지 표시를 지운다. 트리거가 없는 그룹의 행은 남는다(G-13). 실행 뒤 트리거의 그룹과 전체 표시가 모두 풀리므로
 * 지난 트리거도 거부하지 않고 노드의 misfire 처리에 맡긴다(TRD §7.4).
 */
export const resumeAllHandler: CommandHandler<ResumeAllCommand> = {
  type: 'resumeAll',

  async readSubject(conn, ctx, _command, lockWaitSec) {
    return readAll(conn, ctx, lockWaitSec, true);
  },

  plan(_command, subject, { dbNow }) {
    const tooMany = tooManyTargets(subject);
    if (tooMany) return rejected(tooMany);
    const resume = resumeChanges(subject.triggers, {
      dbNow,
      blockingJobs: subject.blockingJobs,
      pausedAfter: new Set(),
    });
    const resumed = new Set([...triggerGroupsOf(subject.triggers), ALL_GROUPS_PAUSED]);
    const kept = subject.pausedGroups.filter((g) => !resumed.has(g));
    return noChangeWarning(
      resumePlanOf(resume, {
        groupChanges: subject.pausedGroups
          .filter((g) => resumed.has(g))
          .map((group) => ({ group, paused: false })),
        warnings: kept.length > 0 ? [pausedGroupsKept(kept)] : [],
      }),
      '전체 일시정지 상태가 아니고 일시정지된 트리거도 없어 바뀌는 것이 없습니다',
    );
  },
};
