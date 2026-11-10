import type {
  CommandChangeDto,
  CommandDeletionDto,
  CommandExpected,
  CommandGroupChangeDto,
  CommandInsertDto,
  CommandNoticeDto,
  CommandScheduleChangeDto,
  CommandTargetDto,
  QuartzCommand,
  JobDto,
  TriggerDto,
  TriggerKey,
} from '@qa/shared';
import type { TargetConn } from '../adapter.js';
import type { SchedulerViewContext } from '../views/views.js';

/** 스케줄러 하나를 제어하는 데 필요한 값. 조회 문맥에 스케줄러 설정 일부를 더한다 */
export interface SchedulerCommandContext extends SchedulerViewContext {
  /** 활성 노드 판정의 체크인 배수(TRD §9.2). 없으면 기본값 3 */
  checkinMultiplier?: number;
}

/** 명령 대상 트리거. 잠금 안에서 다시 읽은 값이다 */
export type CommandTarget = CommandTargetDto;

/**
 * 명령 대상과 계획에 필요한 주변 상태. 핸들러가 읽고, 계획(`plan`)은 이 값만 보고 정한다.
 */
export interface CommandSubject {
  /** 대상 트리거. 그룹·이름 순이다 */
  triggers: CommandTarget[];
  /**
   * 이 명령의 결과에 영향을 주는 그룹 중 `PAUSED_TRIGGER_GRPS`에 있는 것(`_$_ALL_GROUPS_PAUSED_$_` 포함). 이름순.
   * 화면에서 본 상태와 비교하는 값에 들어간다(FR-CTL-00e)
   */
  pausedGroups: string[];
  /**
   * 동시 실행 금지로 실행 중인 잡의 키(`그룹\0이름`). 재개할 때 BLOCKED 판정에 쓴다(`JSS.checkBlockedState`).
   * 재개 명령만 채운다
   */
  blockingJobs: ReadonlySet<string>;
  /** 활성 노드 수. 즉시 실행만 채운다(활성 노드가 없으면 경고, FR-CTL-05) */
  activeNodeCount?: number;
  /** 대상 트리거의 스케줄까지 읽은 값. 스케줄 수정과 트리거 삭제가 채운다 */
  detail?: TriggerDto;
  /** 대상 잡과 그 트리거 전체, JOB_DATA 원본. 삭제가 채운다(durable 판정, 남은 트리거 수, 삭제 전 스냅샷) */
  job?: { dto: JobDto; triggers: TriggerDto[]; jobData: Buffer | null };
  /** 실행 중(`FIRED_TRIGGERS`에 잡 이름이 있는 행)인 트리거 키(`그룹\0이름`). 삭제가 채운다 */
  executing?: ReadonlySet<string>;
}

/** 명령이 거부된 이유. 대상 DB는 바뀌지 않았다 */
export type CommandRejectionCode =
  /** 대상이 없음 (404) */
  | 'NOT_FOUND'
  /** 실행 직전 상태가 화면에서 본 상태와 다름 (409, FR-CTL-00e) */
  | 'STATE_CONFLICT'
  /** 일시정지된 그룹 안의 지난 트리거를 개별로 재개하려 함 (409, TRD §7.4) */
  | 'RESUME_IN_PAUSED_GROUP'
  /** 스케줄 값이 잘못됨 (400, TRD §7.6) */
  | 'INVALID_SCHEDULE'
  /** 캘린더가 연결된 트리거 (409, TRD §7.6) */
  | 'CALENDAR_ATTACHED'
  /** COMPLETE 트리거 (409, TRD §7.6) */
  | 'TRIGGER_COMPLETE'
  /** 트리거 종류가 명령과 맞지 않음 (409) */
  | 'TRIGGER_TYPE_MISMATCH'
  /** 노드가 집은 트리거를 경합이 나는 시각으로 수정하려 함 (409, TRD §7.6) */
  | 'TRIGGER_ACQUIRED';

/** 계획의 거부 사유 중 실행을 거부하는 코드 */
export const REJECTION_CODES: ReadonlySet<string> = new Set<CommandRejectionCode>([
  'RESUME_IN_PAUSED_GROUP',
  'INVALID_SCHEDULE',
  'CALENDAR_ATTACHED',
  'TRIGGER_COMPLETE',
  'TRIGGER_TYPE_MISMATCH',
  'TRIGGER_ACQUIRED',
]);

/**
 * 명령을 실행하지 않고 거부함. 대상 DB 오류(`TargetError`)와 달리 대상 DB는 정상이고 요청이 맞지 않는 경우다.
 * 이 오류가 나면 트랜잭션은 이미 ROLLBACK됐다.
 */
export class CommandRejection extends Error {
  override readonly name = 'CommandRejection';

  constructor(
    readonly code: CommandRejectionCode,
    message: string,
    /**
     * 거부 근거. `STATE_CONFLICT`면 잠금 안에서 다시 읽은 최신 상태,
     * `RESUME_IN_PAUSED_GROUP`이면 해당 트리거 키 목록이다
     */
    readonly current?: CommandExpected | TriggerKey[],
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
  /** 명령을 실행하는 사용자 이름. 즉시 실행 트리거의 DESCRIPTION에 남긴다 */
  actor?: string | null;
}

export interface CommandPlan {
  changes: CommandChangeDto[];
  groupChanges: CommandGroupChangeDto[];
  /** 새로 넣을 트리거. 이름은 적용할 때 정한다(`name`은 null) */
  inserts: CommandInsertDto[];
  /** 스케줄 변경. `state`는 바꾸기 전 상태로, UPDATE 조건에 쓴다 */
  scheduleChanges: (CommandScheduleChangeDto & { state: string })[];
  /** 지울 트리거와 잡. 삭제 명령만 쓴다 */
  deletions?: CommandDeletionDto;
  /** 감사 로그 `before`에 덧붙일 삭제 전 정의 (FR-CTL-09). 삭제 명령만 쓴다 */
  snapshot?: Record<string, unknown>;
  warnings: CommandNoticeDto[];
  /**
   * 실행하면 안 되는 이유. 있으면 미리보기는 차단 사유로 보여 주고, 실행은 대상 DB를 바꾸지 않고 거부한다.
   * 접속 단위 차단(읽기 전용)은 API가 따로 판정한다
   */
  rejection: CommandNoticeDto | null;
}

/**
 * 명령 하나의 동작 (TRD §7.3). 실행 절차(잠금, 상태 확인, 커밋)는 `executeCommand`가 맡고,
 * 핸들러는 대상을 읽고 바꿀 상태를 정하는 일만 한다. 적용(그룹 행, 스케줄, 상태 변경, 트리거 INSERT, 삭제)은 공통(`applyPlan`)이다.
 */
export interface CommandHandler<C extends QuartzCommand = QuartzCommand> {
  readonly type: C['type'];
  /**
   * 대상과 주변 상태를 읽는다. `lockWaitSec`를 주면 대상 트리거 행을 `SELECT … FOR UPDATE`로 잠근다(TRD §7.1 d).
   * 대상이 없으면 `CommandRejection('NOT_FOUND')`를 던진다.
   */
  readSubject(
    conn: TargetConn,
    ctx: SchedulerCommandContext,
    command: C,
    lockWaitSec?: number,
  ): Promise<CommandSubject>;
  /** 바꿀 상태를 정한다. 대상 DB를 읽지 않는 순수 함수다 */
  plan(command: C, subject: CommandSubject, env: PlanEnv): CommandPlan;
}
