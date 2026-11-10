import type { CommandNoticeDto, TriggerJobCommand } from '@qa/shared';
import { queryDbNowMillis } from '../dialect.js';
import { ALL_GROUPS_PAUSED, listNodes } from '../views/views.js';
import { jobWhere } from './pause-resume.js';
import { jobExists, jobKeyOf, selectBlockingJobs, selectPausedGroups } from './triggers.js';
import { CommandRejection, type CommandHandler } from './types.js';

/** 즉시 실행 트리거의 그룹 (`Key.DEFAULT_GROUP`) */
export const DEFAULT_TRIGGER_GROUP = 'DEFAULT';

/** 활성 노드 판정의 체크인 배수 기본값 (TRD §9.2, 스케줄러 설정 기본값과 같다) */
const DEFAULT_CHECKIN_MULTIPLIER = 3;

/**
 * 잡 즉시 실행 (FR-CTL-05, TRD §7.5, `QS.triggerJob`).
 * `DEFAULT` 그룹에 반복 0회 SIMPLE 트리거를 넣는다. 시작 시각과 다음 실행 시각은 대상 DB 현재 시각이다.
 *
 * 상태는 `JSS.storeTrigger`(`forceState=false`)와 같은 규칙으로 정한다(§7.3 "트리거 저장 시 상태 결정").
 * - `DEFAULT` 그룹이 일시정지면 PAUSED
 * - 아니어도 전체 일시정지(`_$_ALL_GROUPS_PAUSED_$_`)면 `DEFAULT` 그룹 행을 넣고 PAUSED
 * - 같은 잡이 동시 실행 금지로 실행 중이면 BLOCKED(일시정지면 PAUSED_BLOCKED)
 *
 * 대상 트리거가 없는 명령이라 화면에서 본 상태로 비교하는 값은 `DEFAULT` 그룹과 전체 일시정지 여부뿐이다.
 */
export const triggerJobHandler: CommandHandler<TriggerJobCommand> = {
  type: 'triggerJob',

  async readSubject(conn, ctx, command) {
    const { group, name } = command.job;
    if (!(await jobExists(conn, ctx, jobWhere('j', group, name)))) {
      throw new CommandRejection('NOT_FOUND', '잡을 찾을 수 없습니다');
    }
    const dbNow = await queryDbNowMillis(conn, ctx.dialect);
    const nodes = await listNodes(conn, ctx, {
      dbNow,
      checkinMultiplier: ctx.checkinMultiplier ?? DEFAULT_CHECKIN_MULTIPLIER,
    });
    return {
      triggers: [],
      pausedGroups: await selectPausedGroups(conn, ctx, [DEFAULT_TRIGGER_GROUP, ALL_GROUPS_PAUSED]),
      blockingJobs: await selectBlockingJobs(conn, ctx),
      activeNodeCount: nodes.filter((n) => n.active).length,
    };
  },

  plan(command, subject, { dbNow, actor }) {
    const { group: jobGroup, name: jobName } = command.job;
    const groupPaused = subject.pausedGroups.includes(DEFAULT_TRIGGER_GROUP);
    const allPaused = subject.pausedGroups.includes(ALL_GROUPS_PAUSED);
    const paused = groupPaused || allPaused;
    const blocking = subject.blockingJobs.has(jobKeyOf(jobGroup, jobName));
    const state = blocking
      ? paused
        ? 'PAUSED_BLOCKED'
        : 'BLOCKED'
      : paused
        ? 'PAUSED'
        : 'WAITING';

    const warnings: CommandNoticeDto[] = [];
    if (blocking) {
      warnings.push({
        code: 'JOB_RUNNING_NONCONCURRENT',
        message: '동시 실행 금지 잡이 이미 실행 중입니다. 지금 실행이 끝난 뒤에 실행됩니다',
      });
    }
    if (paused) {
      warnings.push({
        code: 'INSERTED_PAUSED',
        message: allPaused
          ? '스케줄러 전체가 일시정지 상태라 트리거가 일시정지된 채 들어갑니다. 재개해야 실행됩니다'
          : `${DEFAULT_TRIGGER_GROUP} 트리거 그룹이 일시정지 상태라 트리거가 일시정지된 채 들어갑니다. 그룹을 재개해야 실행됩니다`,
      });
    }
    if (subject.activeNodeCount === 0) {
      warnings.push({
        code: 'NO_ACTIVE_NODE',
        message: '활성 노드가 없습니다. 노드가 다시 뜰 때까지 실행되지 않습니다',
      });
    }

    return {
      changes: [],
      // 전체 일시정지만 걸려 있으면 Quartz는 그 그룹 행을 넣고 일시정지한다(`JSS.storeTrigger`)
      groupChanges:
        allPaused && !groupPaused ? [{ group: DEFAULT_TRIGGER_GROUP, paused: true }] : [],
      inserts: [
        {
          group: DEFAULT_TRIGGER_GROUP,
          name: null,
          jobGroup,
          jobName,
          state,
          startTime: dbNow,
          description: actor ? `quartz-admin: ${actor}` : 'quartz-admin',
        },
      ],
      warnings,
      rejection: null,
    };
  },
};
