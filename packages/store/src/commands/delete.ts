import type {
  CommandNoticeDto,
  DeleteJobCommand,
  DeleteTriggerCommand,
  JobKey,
  TriggerDto,
} from '@qa/shared';
import type { TargetConn } from '../adapter.js';
import { Binds } from '../views/sql.js';
import { getJobDetail, getTriggerDetail } from '../views/views.js';
import { jobWhere, triggerWhere } from './pause-resume.js';
import { selectTriggerTargets } from './triggers.js';
import {
  CommandRejection,
  type CommandHandler,
  type CommandPlan,
  type CommandSubject,
  type SchedulerCommandContext,
} from './types.js';

/*
 * 트리거·잡 삭제 (FR-CTL-08, FR-CTL-09, TRD §7.3, 부록 A.7).
 * 삭제 전 정의를 감사 로그에 남기고(자동 복원은 범위 밖), 실행 중이면 경고한다.
 */

/** 감사 로그에 남기는 JOB_DATA 상한. 넘으면 크기만 남긴다 (TRD §7.3) */
export const SNAPSHOT_JOB_DATA_MAX = 64 * 1024;

const keyOf = (t: { group: string; name: string }) => `${t.group}\u0000${t.name}`;

/**
 * 실행 중인 트리거 키. `FIRED_TRIGGERS`에서 잡 이름이 채워진 행(획득만 된 행은 잡 이름이 NULL)이다.
 * 이 행은 지우지 않는다. 실행이 끝나면 노드가 지운다(`JSS.triggeredJobComplete`)
 */
async function selectExecuting(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  job: JobKey,
): Promise<Set<string>> {
  const { dialect: d, tables } = ctx;
  const q = (a: string) => d.quote(a);
  const b = new Binds(d);
  const rows = await conn.query(
    `SELECT TRIGGER_GROUP AS ${q('G')}, TRIGGER_NAME AS ${q('N')} FROM ${tables.table('FIRED_TRIGGERS')} ` +
      `WHERE SCHED_NAME = ${b.add(ctx.schedName)} AND JOB_GROUP = ${b.add(job.group)} ` +
      `AND JOB_NAME = ${b.add(job.name)}`,
    b.values,
  );
  const out = new Set<string>();
  for (const r of rows) {
    if (typeof r.G === 'string' && typeof r.N === 'string')
      out.add(keyOf({ group: r.G, name: r.N }));
  }
  return out;
}

/** 잡 정의와 트리거, JOB_DATA. 잡이 없으면 null */
async function readJob(conn: TargetConn, ctx: SchedulerCommandContext, key: JobKey) {
  const detail = await getJobDetail(conn, ctx, key);
  return detail ? { dto: detail.job, triggers: detail.triggers, jobData: detail.jobData } : null;
}

/** 감사 로그에 남길 잡 정의. JOB_DATA는 64KB까지 base64로, 넘으면 크기만 */
function jobSnapshot(job: NonNullable<CommandSubject['job']>): Record<string, unknown> {
  const data = job.jobData;
  return {
    job: job.dto,
    jobData: data && data.length <= SNAPSHOT_JOB_DATA_MAX ? data.toString('base64') : null,
    jobDataBytes: data?.length ?? 0,
    triggers: job.triggers,
  };
}

const executingWarning = (message: string): CommandNoticeDto => ({
  code: 'DELETING_EXECUTING',
  message,
});

function deletePlan(
  deletions: NonNullable<CommandPlan['deletions']>,
  snapshot: Record<string, unknown>,
  warnings: CommandNoticeDto[],
): CommandPlan {
  return {
    changes: [],
    groupChanges: [],
    inserts: [],
    scheduleChanges: [],
    deletions,
    snapshot,
    warnings,
    rejection: null,
  };
}

/**
 * 트리거 삭제 (`unscheduleJob`, `JSS.removeTrigger`). 트리거와 하위 행을 지우고, 잡이 durable이 아니고 남은 트리거가
 * 없으면 잡도 지운다(미리 알림, FR-CTL-08). 실행 중인 트리거를 지워도 노드는 완료 처리에서 0행 UPDATE만 하고 끝난다.
 * durable 여부를 읽을 수 없으면 잡을 지우지 않는다.
 */
export const deleteTriggerHandler: CommandHandler<DeleteTriggerCommand> = {
  type: 'deleteTrigger',

  async readSubject(conn, ctx, command, lockWaitSec) {
    const key = command.trigger;
    const triggers = await selectTriggerTargets(
      conn,
      ctx,
      triggerWhere(key.group, key.name),
      lockWaitSec,
    );
    const detail = triggers.length > 0 ? await getTriggerDetail(conn, ctx, key) : null;
    if (!detail) throw new CommandRejection('NOT_FOUND', '트리거를 찾을 수 없습니다');
    const jobKey = { group: detail.jobGroup, name: detail.jobName };
    const job = await readJob(conn, ctx, jobKey);
    return {
      triggers,
      pausedGroups: [],
      blockingJobs: new Set(),
      detail,
      ...(job ? { job } : {}),
      executing: await selectExecuting(conn, ctx, jobKey),
    };
  },

  plan(command, subject) {
    const detail = subject.detail as TriggerDto;
    const job = subject.job;
    const others = job?.triggers.filter((t) => keyOf(t) !== keyOf(command.trigger)).length ?? 0;
    const alsoJob = !!job && job.dto.durable === false && others === 0;
    const warnings: CommandNoticeDto[] = [];
    if (alsoJob) {
      warnings.push({
        code: 'JOB_ALSO_DELETED',
        message: `잡(${detail.jobGroup} / ${detail.jobName})이 durable이 아니고 이 트리거가 마지막이라 잡도 함께 삭제됩니다`,
      });
    }
    if (subject.executing?.has(keyOf(command.trigger))) {
      warnings.push(
        executingWarning(
          '이 트리거로 잡이 실행 중입니다. 지워도 실행은 끝까지 진행되고, 끝나면 노드가 실행 기록을 지웁니다',
        ),
      );
    }
    return deletePlan(
      {
        triggers: [command.trigger],
        jobs: alsoJob ? [{ group: detail.jobGroup, name: detail.jobName }] : [],
      },
      { trigger: detail, ...(alsoJob && job ? jobSnapshot(job) : {}) },
      warnings,
    );
  },
};

/**
 * 잡 삭제 (`QS.deleteJob` → 트리거마다 `removeTrigger`, 마지막에 `JSS.removeJob`). 잡의 모든 트리거와 하위 행, 잡을
 * 한 트랜잭션에서 지운다(Quartz는 트리거마다 나누지만 최종 상태는 같다). 삭제 전 정의를 감사 로그에 남긴다.
 */
export const deleteJobHandler: CommandHandler<DeleteJobCommand> = {
  type: 'deleteJob',

  async readSubject(conn, ctx, command, lockWaitSec) {
    const key = command.job;
    const triggers = await selectTriggerTargets(
      conn,
      ctx,
      jobWhere('t', key.group, key.name),
      lockWaitSec,
    );
    const job = await readJob(conn, ctx, key);
    if (!job) throw new CommandRejection('NOT_FOUND', '잡을 찾을 수 없습니다');
    return {
      triggers,
      pausedGroups: [],
      blockingJobs: new Set(),
      job,
      executing: await selectExecuting(conn, ctx, key),
    };
  },

  plan(command, subject) {
    const job = subject.job!;
    const warnings: CommandNoticeDto[] = [];
    if ((subject.executing?.size ?? 0) > 0) {
      warnings.push(
        executingWarning(
          '이 잡이 실행 중입니다. 지워도 실행은 끝까지 진행되고, 끝나면 노드가 실행 기록을 지웁니다',
        ),
      );
    }
    return deletePlan(
      {
        triggers: subject.triggers.map(({ group, name }) => ({ group, name })),
        jobs: [command.job],
      },
      jobSnapshot(job),
      warnings,
    );
  },
};
