import type {
  CommandChangeDto,
  CommandNoticeDto,
  CommandTargetDto,
  QuartzCommand,
  TriggerStateRef,
} from '@qa/shared';
import type { TargetConn } from '../adapter.js';
import type { SchedulerViewContext } from '../views/views.js';

/** 스케줄러 하나를 제어하는 데 필요한 값. 조회 문맥과 같다 */
export type SchedulerCommandContext = SchedulerViewContext;

/** 명령 대상 트리거. 잠금 안에서 다시 읽은 값이다 */
export type CommandTarget = CommandTargetDto;

/** 명령이 거부된 이유. 대상 DB는 바뀌지 않았다 */
export type CommandRejectionCode =
  /** 대상이 없음 (404) */
  | 'NOT_FOUND'
  /** 실행 직전 상태가 화면에서 본 상태와 다름 (409, FR-CTL-00e) */
  | 'STATE_CONFLICT';

/**
 * 명령을 실행하지 않고 거부함. 대상 DB 오류(`TargetError`)와 달리 대상 DB는 정상이고 요청이 맞지 않는 경우다.
 * 이 오류가 나면 트랜잭션은 이미 ROLLBACK됐다.
 */
export class CommandRejection extends Error {
  override readonly name = 'CommandRejection';

  constructor(
    readonly code: CommandRejectionCode,
    message: string,
    /** `STATE_CONFLICT`일 때 잠금 안에서 다시 읽은 최신 상태 */
    readonly current?: TriggerStateRef[],
  ) {
    super(message);
  }
}

export function isCommandRejection(value: unknown): value is CommandRejection {
  return value instanceof CommandRejection;
}

/** 실행 계획을 세울 때 쓰는 값 */
export interface PlanEnv {
  /** 대상 DB 현재 시각(epoch ms). 잠금 안에서 읽었다 */
  dbNow: number;
}

export interface CommandPlan {
  changes: CommandChangeDto[];
  warnings: CommandNoticeDto[];
}

/**
 * 명령 하나의 동작 (TRD §7.3). 실행 절차(잠금, 상태 확인, 커밋)는 `executeCommand`가 맡고,
 * 핸들러는 대상을 읽고 바꿀 상태를 정해 적용하는 일만 한다.
 */
export interface CommandHandler<C extends QuartzCommand = QuartzCommand> {
  readonly type: C['type'];
  /**
   * 대상 트리거를 읽는다. `lockWaitSec`를 주면 행을 `SELECT … FOR UPDATE`로 잠근다(TRD §7.1 d).
   * 대상이 없으면 `CommandRejection('NOT_FOUND')`를 던진다.
   */
  readTargets(
    conn: TargetConn,
    ctx: SchedulerCommandContext,
    command: C,
    lockWaitSec?: number,
  ): Promise<CommandTarget[]>;
  /** 바꿀 상태를 정한다. 대상 DB를 읽지 않는 순수 함수다 */
  plan(command: C, targets: readonly CommandTarget[], env: PlanEnv): CommandPlan;
  /** 계획을 적용하고 실제로 바뀐 행 수를 돌려준다. 계획의 변경 수와 다르면 실행기가 되돌린다 */
  apply(
    conn: TargetConn,
    ctx: SchedulerCommandContext,
    command: C,
    plan: CommandPlan,
  ): Promise<number>;
}
