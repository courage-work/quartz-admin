/**
 * 제어 명령 API의 요청 스키마와 응답 타입 (TRD §7.1~7.3, PRD FR-CTL)
 *
 * 화면은 먼저 미리보기(`POST /schedulers/:id/commands/preview`)로 대상과 영향 범위를 받아 확인 대화상자에 보여 주고,
 * 미리보기가 돌려준 `expected`(화면에서 본 대상 상태)를 붙여 실행(`POST /schedulers/:id/commands`)한다.
 * 실행 직전에 서버가 대상 상태를 다시 읽어 `expected`와 다르면 409 `STATE_CONFLICT`로 중단한다(FR-CTL-00e).
 */
import { z } from 'zod';
import type { TriggerState } from './quartz.js';

/** Quartz 이름 컬럼 길이(VARCHAR2(200)) */
const NAME_MAX = 200;

/** 한 명령이 다루는 트리거 수 상한. 스케줄러당 트리거 10,000개 규모(TRD §8.1)를 기준으로 한다 */
export const COMMAND_TARGETS_MAX = 10_000;

export const triggerKeySchema = z.object({
  group: z.string({ error: '트리거 그룹이 필요합니다' }).min(1).max(NAME_MAX),
  name: z.string({ error: '트리거 이름이 필요합니다' }).min(1).max(NAME_MAX),
});
export type TriggerKey = z.infer<typeof triggerKeySchema>;

/** 트리거 일시정지 (FR-CTL-01, TRD §7.3 `pauseTrigger`) */
export const pauseTriggerCommandSchema = z.object({
  type: z.literal('pauseTrigger'),
  trigger: triggerKeySchema,
});
export type PauseTriggerCommand = z.infer<typeof pauseTriggerCommandSchema>;

/**
 * 제어 명령. `type`으로 나눈다. 명령을 추가하는 작업(B-18~B-21)이 여기에 이어 붙인다.
 * 서버(`@qa/store`의 명령 핸들러)와 화면이 같은 목록을 쓴다.
 */
export const commandSchema = z.discriminatedUnion('type', [pauseTriggerCommandSchema]);
export type QuartzCommand = z.infer<typeof commandSchema>;
export type CommandType = QuartzCommand['type'];

/** 대상 트리거 하나와 그 상태(`TRIGGER_STATE` 원래 값) */
export const triggerStateRefSchema = triggerKeySchema.extend({
  state: z.string().min(1).max(16),
});
export type TriggerStateRef = z.infer<typeof triggerStateRefSchema>;

/** `POST /schedulers/:id/commands/preview` */
export const commandPreviewRequestSchema = z.object({ command: commandSchema });
export type CommandPreviewRequest = z.infer<typeof commandPreviewRequestSchema>;

/** `POST /schedulers/:id/commands`. `expected`는 미리보기 응답의 `expected`를 그대로 보낸다 */
export const commandRequestSchema = z.object({
  command: commandSchema,
  expected: z.array(triggerStateRefSchema).max(COMMAND_TARGETS_MAX),
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;

/**
 * 화면에서 본 상태와 실행 직전 상태를 비교할 때 쓰는 상태 묶음.
 * Quartz `JobStoreSupport.getTriggerState`가 `Scheduler.getTriggerState`로 돌려주는 분류와 같다.
 * WAITING과 ACQUIRED는 노드가 발화 30초 전부터 수시로 오가는 상태라 같은 것으로 본다(TRD §7.1 d).
 */
export type TriggerStateClass = 'NORMAL' | 'PAUSED' | 'BLOCKED' | 'COMPLETE' | 'ERROR' | 'NONE';

export function triggerStateClass(state: string): TriggerStateClass {
  switch (state) {
    case 'DELETED':
      return 'NONE';
    case 'COMPLETE':
      return 'COMPLETE';
    case 'PAUSED':
    case 'PAUSED_BLOCKED':
      return 'PAUSED';
    case 'ERROR':
      return 'ERROR';
    case 'BLOCKED':
      return 'BLOCKED';
    default:
      return 'NORMAL';
  }
}

/** `pauseTrigger`의 상태 전이 (TRD §7.3, `JSS.pauseTrigger`). 표에 없는 상태는 바꾸지 않는다 */
export const PAUSE_TRIGGER_TRANSITIONS: Readonly<Partial<Record<TriggerState, TriggerState>>> = {
  WAITING: 'PAUSED',
  ACQUIRED: 'PAUSED',
  BLOCKED: 'PAUSED_BLOCKED',
};

/** 대상 트리거. 확인 대화상자에 대상과 연결된 잡을 보여 준다 */
export interface CommandTargetDto extends TriggerStateRef {
  jobGroup: string;
  jobName: string;
}

/** 트리거 하나의 상태 변경 */
export interface CommandChangeDto extends TriggerKey {
  from: string;
  to: string;
}

/** 미리보기의 경고·차단 사유 */
export const COMMAND_NOTICE_CODES = [
  /** 읽기 전용으로 지정한 접속 (FR-CTL-00a) */
  'READ_ONLY',
  /** 자동 감지에서 쓰기 권한을 확인하지 못한 접속 (FR-CON-04) */
  'WRITE_NOT_CAPABLE',
  /** 실행해도 바뀌는 상태가 없음 */
  'NO_CHANGE',
] as const;
export type CommandNoticeCode = (typeof COMMAND_NOTICE_CODES)[number];

export interface CommandNoticeDto {
  code: CommandNoticeCode;
  message: string;
}

/** 확인 대화상자에 보여 줄 스케줄러 정보 (FR-CTL-00b) */
export interface CommandSchedulerDto {
  id: number;
  displayName: string;
  schedName: string;
  connectionName: string;
  envLabel: string;
}

export interface CommandPreviewResponse {
  /** 대상을 읽은 대상 DB 시각 */
  dbNow: number;
  command: QuartzCommand;
  scheduler: CommandSchedulerDto;
  targets: CommandTargetDto[];
  /** 실행 요청에 그대로 붙여 보낼 값. 서버는 실행 직전 상태와 비교한다 */
  expected: TriggerStateRef[];
  /** 실행하면 바뀔 상태. 비어 있으면 바뀌는 것이 없다 */
  changes: CommandChangeDto[];
  warnings: CommandNoticeDto[];
  /** 실행할 수 없는 이유. 있으면 화면은 실행 버튼을 끈다 */
  blocked: CommandNoticeDto | null;
}

export interface CommandResultDto {
  /** 실행한 트랜잭션 안의 대상 DB 시각 */
  dbNow: number;
  command: QuartzCommand;
  /** 실제로 바뀐 행이 있는지. 없으면 "변경 없음"으로 알린다 */
  changed: boolean;
  changes: CommandChangeDto[];
  /** 잠금 안에서 다시 읽은 실행 직전 상태 */
  before: TriggerStateRef[];
  /** 같은 트랜잭션에서 읽은 실행 직후 상태 */
  after: TriggerStateRef[];
  /** 남긴 감사 기록 ID */
  auditId: number;
}
