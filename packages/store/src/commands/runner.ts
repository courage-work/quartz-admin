import {
  triggerStateClass,
  type CommandChangeDto,
  type CommandExpected,
  type CommandGroupChangeDto,
  type CommandNoticeDto,
  type CommandType,
  type QuartzCommand,
  type TriggerStateRef,
} from '@qa/shared';
import type { TargetConn } from '../adapter.js';
import { queryDbNowMillis } from '../dialect.js';
import { LOCK_WAIT_SEC, acquireTriggerAccess, type LockAcquisition } from './lock.js';
import {
  pauseJobGroupHandler,
  pauseJobHandler,
  pauseTriggerGroupHandler,
  pauseTriggerHandler,
  resumeJobGroupHandler,
  resumeJobHandler,
  resumeTriggerGroupHandler,
  resumeTriggerHandler,
} from './pause-resume.js';
import { applyPlan } from './triggers.js';
import {
  CommandRejection,
  type CommandHandler,
  type CommandPlan,
  type CommandSubject,
  type CommandTarget,
  type SchedulerCommandContext,
} from './types.js';

type HandlerMap = { [K in CommandType]: CommandHandler<Extract<QuartzCommand, { type: K }>> };

/** 명령 종류별 핸들러. 명령을 추가하면 타입 오류로 빠진 핸들러를 알려 준다 */
const HANDLERS: HandlerMap = {
  pauseTrigger: pauseTriggerHandler,
  resumeTrigger: resumeTriggerHandler,
  pauseJob: pauseJobHandler,
  resumeJob: resumeJobHandler,
  pauseTriggerGroup: pauseTriggerGroupHandler,
  resumeTriggerGroup: resumeTriggerGroupHandler,
  pauseJobGroup: pauseJobGroupHandler,
  resumeJobGroup: resumeJobGroupHandler,
};

function handlerFor(command: QuartzCommand): CommandHandler {
  return HANDLERS[command.type];
}

/** 대상의 키와 상태만 남긴다 */
export function stateRefs(targets: readonly CommandTarget[]): TriggerStateRef[] {
  return targets.map(({ group, name, state }) => ({ group, name, state }));
}

/** 화면에서 본 상태와 비교하는 값 */
export function expectedOf(subject: CommandSubject): CommandExpected {
  return { triggers: stateRefs(subject.triggers), pausedGroups: [...subject.pausedGroups] };
}

const keyOf = (t: { group: string; name: string }) => `${t.group}\u0000${t.name}`;

/**
 * 화면에서 본 대상과 실행 직전 대상이 같은지 (FR-CTL-00e). 대상 집합이 같고, 트리거마다 상태 분류
 * (`triggerStateClass`, Quartz `getTriggerState`와 같은 분류)가 같아야 한다. 순서는 보지 않는다.
 */
export function sameTargets(
  expected: readonly TriggerStateRef[],
  actual: readonly TriggerStateRef[],
): boolean {
  if (expected.length !== actual.length) return false;
  const seen = new Map(expected.map((t) => [keyOf(t), triggerStateClass(t.state)]));
  if (seen.size !== expected.length) return false;
  return actual.every((t) => seen.get(keyOf(t)) === triggerStateClass(t.state));
}

/** 대상 트리거(`sameTargets`)와 관련 그룹의 일시정지 여부가 모두 같은지. 그룹 순서는 보지 않는다 */
export function sameExpected(expected: CommandExpected, actual: CommandExpected): boolean {
  if (!sameTargets(expected.triggers, actual.triggers)) return false;
  const want = new Set(expected.pausedGroups);
  const have = new Set(actual.pausedGroups);
  return want.size === have.size && [...want].every((g) => have.has(g));
}

export interface CommandPreview {
  dbNow: number;
  subject: CommandSubject;
  plan: CommandPlan;
}

/**
 * 명령 미리보기. 잠금 없이 대상을 읽고 바뀔 상태를 계산한다. 대상 DB를 바꾸지 않는다.
 * 대상이 없으면 `CommandRejection('NOT_FOUND')`를 던진다. 실행할 수 없는 명령이면 `plan.rejection`에 이유가 있다.
 */
export async function previewCommand(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  command: QuartzCommand,
): Promise<CommandPreview> {
  const handler = handlerFor(command);
  const dbNow = await queryDbNowMillis(conn, ctx.dialect);
  const subject = await handler.readSubject(conn, ctx, command);
  return { dbNow, subject, plan: handler.plan(command, subject, { dbNow }) };
}

export interface ExecuteOptions {
  /** 잠금 대기 제한(초). 기본 5 (FR-CTL-00c) */
  lockWaitSec?: number;
}

export interface CommandOutcome {
  /** 잠금을 잡은 뒤 읽은 대상 DB 시각 */
  dbNow: number;
  lock: LockAcquisition;
  /** 잠금 안에서 다시 읽은 실행 직전 대상 */
  before: CommandSubject;
  /** 같은 트랜잭션에서 읽은 실행 직후 대상 */
  after: CommandSubject;
  changes: CommandChangeDto[];
  groupChanges: CommandGroupChangeDto[];
  warnings: CommandNoticeDto[];
}

async function rollbackQuietly(conn: TargetConn): Promise<void> {
  try {
    await conn.rollback();
  } catch {
    // 끊긴 커넥션이면 DB가 이미 되돌렸다. 커넥션은 풀이 버린다
  }
}

/**
 * 명령 실행 (TRD §7.1 4단계). 한 트랜잭션 안에서 잠금 행 확보 → 대상 행 잠금과 재조회 →
 * 기대 상태 비교 → 상태 조건부 변경 → 변경 후 조회 → COMMIT 순서로 진행한다.
 *
 * - 잠금 범위 안에서는 대상 DB 호출만 한다. 메타 저장소 기록과 직렬화는 호출자(API)가 앞뒤에서 맡는다
 * - 어떤 실패든 ROLLBACK하고 오류를 그대로 던진다. 대상 DB는 바뀌지 않는다
 *   - 잠금 대기 초과: `TargetError('LOCK_TIMEOUT')`
 *   - 기대 상태와 다름: `CommandRejection('STATE_CONFLICT')`와 최신 상태
 *   - 명령별 거부(예: 그룹 일시정지 안의 지난 트리거 재개): `CommandRejection('RESUME_IN_PAUSED_GROUP')`
 *   - 그 밖의 DB 오류(교착 롤백 포함): `TargetError`
 */
export async function executeCommand(
  conn: TargetConn,
  ctx: SchedulerCommandContext,
  command: QuartzCommand,
  expected: CommandExpected,
  options: ExecuteOptions = {},
): Promise<CommandOutcome> {
  const handler = handlerFor(command);
  const { dialect: d } = ctx;
  const waitSec = options.lockWaitSec ?? LOCK_WAIT_SEC;

  await d.beforeLockedTx(conn, waitSec);
  try {
    const lock = await acquireTriggerAccess(conn, ctx, waitSec);
    const dbNow = await queryDbNowMillis(conn, d);
    const before = await handler.readSubject(conn, ctx, command, waitSec);
    if (!sameExpected(expected, expectedOf(before))) {
      throw new CommandRejection(
        'STATE_CONFLICT',
        '화면에서 본 상태와 지금 상태가 달라 실행하지 않았습니다. 최신 상태를 확인하고 다시 실행하세요',
        expectedOf(before),
      );
    }

    const plan = handler.plan(command, before, { dbNow });
    if (plan.rejection) {
      throw new CommandRejection(
        'RESUME_IN_PAUSED_GROUP',
        plan.rejection.message,
        plan.rejection.triggers,
      );
    }
    let after = before;
    const planned = plan.changes.length + plan.groupChanges.length;
    if (planned > 0) {
      const changed = await applyPlan(conn, ctx, plan);
      after = await handler.readSubject(conn, ctx, command);
      if (changed !== planned) {
        // 잠근 행이 그 사이 바뀌었다. 잠금을 거치지 않은 쓰기가 있다는 뜻이므로 되돌린다
        throw new CommandRejection(
          'STATE_CONFLICT',
          '실행 도중 대상 상태가 바뀌어 되돌렸습니다. 최신 상태를 확인하고 다시 실행하세요',
          expectedOf(after),
        );
      }
    }
    await conn.commit();
    return {
      dbNow,
      lock,
      before,
      after,
      changes: plan.changes,
      groupChanges: plan.groupChanges,
      warnings: plan.warnings,
    };
  } catch (err) {
    await rollbackQuietly(conn);
    throw err;
  } finally {
    try {
      await d.afterLockedTx(conn);
    } catch {
      // 세션 설정 원복 실패가 이미 끝난 커밋 결과를 실패로 바꾸지 않게 한다
    }
  }
}
