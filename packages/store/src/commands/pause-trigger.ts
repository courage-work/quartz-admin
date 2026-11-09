import { PAUSE_TRIGGER_TRANSITIONS, type PauseTriggerCommand } from '@qa/shared';
import { applyStateChanges, selectTriggerTargets } from './triggers.js';
import { CommandRejection, type CommandHandler } from './types.js';

const TRANSITIONS: Readonly<Record<string, string | undefined>> = PAUSE_TRIGGER_TRANSITIONS;

/**
 * 트리거 일시정지 (FR-CTL-01, TRD §7.3, `JSS.pauseTrigger`).
 * WAITING·ACQUIRED → PAUSED, BLOCKED → PAUSED_BLOCKED. `PAUSED_TRIGGER_GRPS`와 NEXT_FIRE_TIME은 건드리지 않는다.
 * 그 밖의 상태(PAUSED, PAUSED_BLOCKED, ERROR, COMPLETE)는 바꾸지 않는다(부록 A.2 P-04).
 */
export const pauseTriggerHandler: CommandHandler<PauseTriggerCommand> = {
  type: 'pauseTrigger',

  async readTargets(conn, ctx, command, lockWaitSec) {
    const { group, name } = command.trigger;
    const targets = await selectTriggerTargets(
      conn,
      ctx,
      (b) => `t.TRIGGER_GROUP = ${b.add(group)} AND t.TRIGGER_NAME = ${b.add(name)}`,
      lockWaitSec,
    );
    if (targets.length === 0) throw new CommandRejection('NOT_FOUND', '트리거를 찾을 수 없습니다');
    return targets;
  },

  plan(_command, targets) {
    const changes = targets.flatMap((t) => {
      const to = TRANSITIONS[t.state];
      return to === undefined ? [] : [{ group: t.group, name: t.name, from: t.state, to }];
    });
    const state = targets[0]?.state ?? '';
    return {
      changes,
      warnings:
        changes.length === 0
          ? [
              {
                code: 'NO_CHANGE',
                message: `지금 상태(${state})에서는 일시정지해도 바뀌는 것이 없습니다`,
              },
            ]
          : [],
    };
  },

  apply(conn, ctx, _command, plan) {
    return applyStateChanges(conn, ctx, plan.changes);
  },
};
