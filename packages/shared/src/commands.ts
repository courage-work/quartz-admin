/**
 * 제어 명령 API의 요청 스키마와 응답 타입 (TRD §7.1~7.6, PRD FR-CTL)
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

/** 확인 대화상자와 감사 기록에 대상 트리거를 하나씩 적는 최대 수. 넘으면 수만 적는다 */
export const COMMAND_TARGETS_LISTED = 20;

export const triggerKeySchema = z.object({
  group: z.string({ error: '트리거 그룹이 필요합니다' }).min(1).max(NAME_MAX),
  name: z.string({ error: '트리거 이름이 필요합니다' }).min(1).max(NAME_MAX),
});
export type TriggerKey = z.infer<typeof triggerKeySchema>;

export const jobKeySchema = z.object({
  group: z.string({ error: '잡 그룹이 필요합니다' }).min(1).max(NAME_MAX),
  name: z.string({ error: '잡 이름이 필요합니다' }).min(1).max(NAME_MAX),
});
export type JobKey = z.infer<typeof jobKeySchema>;

const groupNameSchema = z.string({ error: '그룹 이름이 필요합니다' }).min(1).max(NAME_MAX);

/** 트리거 일시정지 (FR-CTL-01, TRD §7.3 `pauseTrigger`) */
export const pauseTriggerCommandSchema = z.object({
  type: z.literal('pauseTrigger'),
  trigger: triggerKeySchema,
});
export type PauseTriggerCommand = z.infer<typeof pauseTriggerCommandSchema>;

/** 트리거 재개 (FR-CTL-01, TRD §7.3 `resumeTrigger`, §7.4) */
export const resumeTriggerCommandSchema = z.object({
  type: z.literal('resumeTrigger'),
  trigger: triggerKeySchema,
});
export type ResumeTriggerCommand = z.infer<typeof resumeTriggerCommandSchema>;

/** 잡의 모든 트리거 일시정지 (FR-CTL-02, `pauseJob`) */
export const pauseJobCommandSchema = z.object({
  type: z.literal('pauseJob'),
  job: jobKeySchema,
});
export type PauseJobCommand = z.infer<typeof pauseJobCommandSchema>;

/** 잡의 모든 트리거 재개 (FR-CTL-02, `resumeJob`) */
export const resumeJobCommandSchema = z.object({
  type: z.literal('resumeJob'),
  job: jobKeySchema,
});
export type ResumeJobCommand = z.infer<typeof resumeJobCommandSchema>;

/** 트리거 그룹 일시정지 (FR-CTL-03, `pauseTriggers(GroupMatcher.groupEquals)`) */
export const pauseTriggerGroupCommandSchema = z.object({
  type: z.literal('pauseTriggerGroup'),
  group: groupNameSchema,
});
export type PauseTriggerGroupCommand = z.infer<typeof pauseTriggerGroupCommandSchema>;

/** 트리거 그룹 재개 (FR-CTL-03, `resumeTriggers(GroupMatcher.groupEquals)`) */
export const resumeTriggerGroupCommandSchema = z.object({
  type: z.literal('resumeTriggerGroup'),
  group: groupNameSchema,
});
export type ResumeTriggerGroupCommand = z.infer<typeof resumeTriggerGroupCommandSchema>;

/** 잡 그룹 일시정지 (FR-CTL-03, `pauseJobs`). JDBC JobStore는 저장하지 않아 이후 추가되는 잡에는 적용되지 않는다 */
export const pauseJobGroupCommandSchema = z.object({
  type: z.literal('pauseJobGroup'),
  group: groupNameSchema,
});
export type PauseJobGroupCommand = z.infer<typeof pauseJobGroupCommandSchema>;

/** 잡 그룹 재개 (FR-CTL-03, `resumeJobs`) */
export const resumeJobGroupCommandSchema = z.object({
  type: z.literal('resumeJobGroup'),
  group: groupNameSchema,
});
export type ResumeJobGroupCommand = z.infer<typeof resumeJobGroupCommandSchema>;

/** 잡 즉시 실행 (FR-CTL-05, `triggerJob(jobKey)`, TRD §7.5): 지금 한 번 실행하는 일회성 SIMPLE 트리거를 넣는다 */
export const triggerJobCommandSchema = z.object({
  type: z.literal('triggerJob'),
  job: jobKeySchema,
});
export type TriggerJobCommand = z.infer<typeof triggerJobCommandSchema>;

/** `CRON_TRIGGERS.CRON_EXPRESSION` 길이(VARCHAR2(120)) */
export const CRON_EXPRESSION_MAX = 120;
/** `CRON_TRIGGERS.TIME_ZONE_ID` 길이(VARCHAR2(80)) */
export const TIME_ZONE_ID_MAX = 80;
/** `SIMPLE_TRIGGERS.REPEAT_COUNT` 상한(Oracle NUMBER(7)) */
export const REPEAT_COUNT_MAX = 9_999_999;
/** `SIMPLE_TRIGGERS.REPEAT_INTERVAL` 상한(Oracle NUMBER(12), ms) */
export const REPEAT_INTERVAL_MAX = 999_999_999_999;

/** CRON 스케줄 수정 (FR-CTL-06, TRD §7.6): 식과 타임존을 바꾸고 다음 실행 시각을 다시 계산한다 */
export const updateCronScheduleCommandSchema = z.object({
  type: z.literal('updateCronSchedule'),
  trigger: triggerKeySchema,
  cronExpression: z
    .string({ error: 'cron 표현식이 필요합니다' })
    .trim()
    .min(1, 'cron 표현식이 필요합니다')
    .max(CRON_EXPRESSION_MAX, `cron 표현식은 ${CRON_EXPRESSION_MAX}자까지입니다`),
  /** Java TimeZone ID */
  timeZone: z
    .string({ error: '타임존이 필요합니다' })
    .trim()
    .min(1, '타임존이 필요합니다')
    .max(TIME_ZONE_ID_MAX),
});
export type UpdateCronScheduleCommand = z.infer<typeof updateCronScheduleCommandSchema>;

/**
 * SIMPLE 스케줄 수정 (FR-CTL-07, TRD §7.6): 간격과 반복 횟수를 바꾸고 `startAt`(기본은 대상 DB 현재 시각)부터 다시 시작한다
 */
export const updateSimpleScheduleCommandSchema = z.object({
  type: z.literal('updateSimpleSchedule'),
  trigger: triggerKeySchema,
  repeatIntervalMs: z
    .number({ error: '반복 간격이 필요합니다' })
    .int('반복 간격은 정수(ms)여야 합니다')
    .min(0, '반복 간격은 0 이상이어야 합니다')
    .max(REPEAT_INTERVAL_MAX),
  /** -1은 무한 반복 */
  repeatCount: z
    .number({ error: '반복 횟수가 필요합니다' })
    .int('반복 횟수는 정수여야 합니다')
    .min(-1, '반복 횟수는 0 이상이거나 -1(무한)이어야 합니다')
    .max(REPEAT_COUNT_MAX),
  /** 다시 시작할 시각(epoch ms). 없으면 대상 DB 현재 시각 */
  startAt: z.number().int().positive().optional(),
});
export type UpdateSimpleScheduleCommand = z.infer<typeof updateSimpleScheduleCommandSchema>;

/**
 * 트리거 삭제 (FR-CTL-08, `unscheduleJob`, TRD §7.3). 잡이 durable이 아니고 마지막 트리거면 잡도 지운다
 */
export const deleteTriggerCommandSchema = z.object({
  type: z.literal('deleteTrigger'),
  trigger: triggerKeySchema,
});
export type DeleteTriggerCommand = z.infer<typeof deleteTriggerCommandSchema>;

/** 잡 삭제 (FR-CTL-09, `deleteJob`, TRD §7.3): 잡의 모든 트리거와 하위 행, 잡을 지운다 */
export const deleteJobCommandSchema = z.object({
  type: z.literal('deleteJob'),
  job: jobKeySchema,
});
export type DeleteJobCommand = z.infer<typeof deleteJobCommandSchema>;

/**
 * 제어 명령. `type`으로 나눈다. 서버(`@qa/store`의 명령 핸들러)와 화면이 같은 목록을 쓴다.
 * 서버(`@qa/store`의 명령 핸들러)와 화면이 같은 목록을 쓴다.
 */
export const commandSchema = z.discriminatedUnion('type', [
  pauseTriggerCommandSchema,
  resumeTriggerCommandSchema,
  pauseJobCommandSchema,
  resumeJobCommandSchema,
  pauseTriggerGroupCommandSchema,
  resumeTriggerGroupCommandSchema,
  pauseJobGroupCommandSchema,
  resumeJobGroupCommandSchema,
  triggerJobCommandSchema,
  updateCronScheduleCommandSchema,
  updateSimpleScheduleCommandSchema,
  deleteTriggerCommandSchema,
  deleteJobCommandSchema,
]);
export type QuartzCommand = z.infer<typeof commandSchema>;
export type CommandType = QuartzCommand['type'];

/** 명령이 무엇을 대상으로 하는지. 감사 기록의 대상 종류와 화면 문구에 쓴다 */
export type CommandScope = 'trigger' | 'job' | 'triggerGroup' | 'jobGroup';

export function commandScope(command: QuartzCommand): CommandScope {
  switch (command.type) {
    case 'pauseTrigger':
    case 'resumeTrigger':
    case 'updateCronSchedule':
    case 'updateSimpleSchedule':
    case 'deleteTrigger':
      return 'trigger';
    case 'pauseJob':
    case 'resumeJob':
    case 'triggerJob':
    case 'deleteJob':
      return 'job';
    case 'pauseTriggerGroup':
    case 'resumeTriggerGroup':
      return 'triggerGroup';
    case 'pauseJobGroup':
    case 'resumeJobGroup':
      return 'jobGroup';
  }
}

/** 대상 트리거 하나와 그 상태(`TRIGGER_STATE` 원래 값) */
export const triggerStateRefSchema = triggerKeySchema.extend({
  state: z.string().min(1).max(16),
});
export type TriggerStateRef = z.infer<typeof triggerStateRefSchema>;

/**
 * 화면에서 본 대상 상태. 실행 직전에 서버가 다시 읽은 값과 비교한다(FR-CTL-00e).
 * - `triggers`: 대상 트리거와 상태
 * - `pausedGroups`: 이 명령의 결과에 영향을 주는 그룹 중 `PAUSED_TRIGGER_GRPS`에 있는 것(`_$_ALL_GROUPS_PAUSED_$_` 포함).
 *   일시정지 명령은 대개 비어 있고, 재개와 그룹 명령이 쓴다
 */
export const commandExpectedSchema = z.object({
  triggers: z.array(triggerStateRefSchema).max(COMMAND_TARGETS_MAX),
  pausedGroups: z.array(groupNameSchema).max(COMMAND_TARGETS_MAX),
});
export type CommandExpected = z.infer<typeof commandExpectedSchema>;

/** `POST /schedulers/:id/commands/preview` */
export const commandPreviewRequestSchema = z.object({ command: commandSchema });
export type CommandPreviewRequest = z.infer<typeof commandPreviewRequestSchema>;

/** `POST /schedulers/:id/commands`. `expected`는 미리보기 응답의 `expected`를 그대로 보낸다 */
export const commandRequestSchema = z.object({
  command: commandSchema,
  expected: commandExpectedSchema,
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

/** 일시정지의 상태 전이 (TRD §7.3, `JSS.pauseTrigger`). 표에 없는 상태는 바꾸지 않는다 */
export const PAUSE_TRIGGER_TRANSITIONS: Readonly<Partial<Record<TriggerState, TriggerState>>> = {
  WAITING: 'PAUSED',
  ACQUIRED: 'PAUSED',
  BLOCKED: 'PAUSED_BLOCKED',
};

/**
 * 재개할 수 있는 상태 (TRD §7.3, `JSS.resumeTrigger`). 새 상태는 같은 잡이 동시 실행 금지로 실행 중이면 BLOCKED,
 * 아니면 WAITING이다. NEXT_FIRE_TIME이 없으면 바꾸지 않는다.
 */
export const RESUMABLE_TRIGGER_STATES: readonly TriggerState[] = ['PAUSED', 'PAUSED_BLOCKED'];

/** 대상 트리거. 확인 대화상자에 대상과 연결된 잡을 보여 준다 */
export interface CommandTargetDto extends TriggerStateRef {
  jobGroup: string;
  jobName: string;
  /** NEXT_FIRE_TIME(epoch ms). 없으면(-1, 0, NULL) null */
  nextFireTime: number | null;
}

/** 트리거 하나의 상태 변경 */
export interface CommandChangeDto extends TriggerKey {
  from: string;
  to: string;
}

/**
 * 새로 넣는 트리거(즉시 실행, TRD §7.5). 미리보기에서는 이름이 아직 없고(`name`이 null), 실행 결과에는 실제로 넣은 이름이 온다.
 * 이름은 Quartz `triggerJob`과 같은 형식(`MT_` + 난수)이라 실행할 때 정한다
 */
export interface CommandInsertDto {
  group: string;
  name: string | null;
  jobGroup: string;
  jobName: string;
  /** 넣을 때의 상태(`JSS.storeTrigger`의 상태 결정 규칙) */
  state: string;
  /** START_TIME = NEXT_FIRE_TIME(epoch ms). 대상 DB 현재 시각이다 */
  startTime: number;
  /** DESCRIPTION. 누가 넣었는지 남긴다(\`quartz-admin: <사용자명>\`, Quartz와 의도된 차이) */
  description: string;
}

/** 트리거 스케줄의 한 시점 값. 스케줄 수정의 전·후를 보여 준다 */
export interface ScheduleSnapshotDto {
  kind: 'CRON' | 'SIMPLE';
  cronExpression?: string;
  /** Java TimeZone ID. 없으면 Quartz는 JVM 기본 타임존을 쓴다 */
  timeZone?: string | null;
  repeatIntervalMs?: number;
  repeatCount?: number;
  timesTriggered?: number;
  startTime: number | null;
  nextFireTime: number | null;
}

/** 스케줄 수정 (TRD §7.6). `upcoming`은 수정 뒤 다음 실행 시각부터 최대 5개 */
export interface CommandScheduleChangeDto extends TriggerKey {
  from: ScheduleSnapshotDto;
  to: ScheduleSnapshotDto;
  upcoming: number[];
}

/** 지울 트리거와 잡 (TRD §7.3). 트리거는 하위 테이블 행과 함께 지운다 */
export interface CommandDeletionDto {
  triggers: TriggerKey[];
  jobs: JobKey[];
}

/** `PAUSED_TRIGGER_GRPS` 행 변경. `paused`가 참이면 넣고 거짓이면 지운다 */
export interface CommandGroupChangeDto {
  group: string;
  paused: boolean;
}

/** 미리보기의 경고·차단 사유 */
export const COMMAND_NOTICE_CODES = [
  /** 읽기 전용으로 지정한 접속 (FR-CTL-00a) */
  'READ_ONLY',
  /** 자동 감지에서 쓰기 권한을 확인하지 못한 접속 (FR-CON-04) */
  'WRITE_NOT_CAPABLE',
  /** 실행해도 바뀌는 상태가 없음 */
  'NO_CHANGE',
  /** 일시정지된 그룹 안의 지난 트리거를 개별로 재개하려 함. 그룹을 먼저 재개해야 함 (TRD §7.4) */
  'RESUME_IN_PAUSED_GROUP',
  /** 재개한 트리거 중 실행 시각이 지난 것이 있음. Quartz 노드가 misfire 정책으로 처리함 (TRD §7.4) */
  'MISFIRE_DELEGATED',
  /** 다음 실행 시각이 없어 재개해도 상태를 바꾸지 않는 트리거가 있음 (`JSS.resumeTrigger`) */
  'NO_NEXT_FIRE_TIME',
  /** 잡 그룹 일시정지는 저장되지 않아 이후 추가되는 잡에는 적용되지 않음 (TRD §7.3) */
  'JOB_GROUP_NOT_STORED',
  /** 동시 실행 금지 잡이 이미 실행 중이라 즉시 실행 트리거가 BLOCKED로 들어감 (FR-CTL-05) */
  'JOB_RUNNING_NONCONCURRENT',
  /** 활성 노드가 없어 노드가 다시 뜰 때까지 실행되지 않음 (FR-CTL-05) */
  'NO_ACTIVE_NODE',
  /** 트리거 그룹(또는 전체)이 일시정지돼 즉시 실행 트리거가 PAUSED로 들어감 (TRD §7.5) */
  'INSERTED_PAUSED',
  /** 스케줄 값이 잘못됨: cron 문법, 타임존, 반복 값, 시작·종료 시각, 더 이상 발화하지 않음 (400, TRD §7.6) */
  'INVALID_SCHEDULE',
  /** 캘린더가 연결된 트리거라 스케줄을 수정할 수 없음 (409, TRD §7.6) */
  'CALENDAR_ATTACHED',
  /** COMPLETE 트리거(곧 삭제됨)라 스케줄을 수정할 수 없음 (409, TRD §7.6) */
  'TRIGGER_COMPLETE',
  /** 트리거 종류가 명령과 맞지 않음(CRON 수정을 SIMPLE 트리거에 등) (409) */
  'TRIGGER_TYPE_MISMATCH',
  /**
   * 노드가 집은(ACQUIRED) 트리거인데 새 스케줄의 실행 시각이 옛 발화 시각 직후라, 다른 노드가 먼저 집으면 옛 스케줄로
   * 실행되고 수정이 되돌아갈 수 있음 (409, TRD §7.2·§7.6)
   */
  'TRIGGER_ACQUIRED',
  /** ERROR 상태가 풀려 WAITING이 됨 (TRD §7.6) */
  'ERROR_CLEARED',
  /** 개별 일시정지는 수정 뒤에도 유지됨(Quartz `rescheduleJob`과 의도된 차이, TRD §7.6) */
  'PAUSE_KEPT',
  /** durable이 아닌 잡의 마지막 트리거라 잡도 함께 지움 (FR-CTL-08) */
  'JOB_ALSO_DELETED',
  /** 지우는 트리거·잡이 실행 중. 실행은 끝까지 진행되고 노드가 완료 기록을 지움 (FR-CTL-09) */
  'DELETING_EXECUTING',
] as const;
export type CommandNoticeCode = (typeof COMMAND_NOTICE_CODES)[number];

export interface CommandNoticeDto {
  code: CommandNoticeCode;
  message: string;
  /** 사유에 해당하는 트리거. 많으면 앞쪽 `COMMAND_TARGETS_LISTED`개만 온다 */
  triggers?: TriggerKey[];
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
  /** 대상 트리거. 그룹·잡 명령이면 여러 개이고 트리거가 하나도 없을 수도 있다 */
  targets: CommandTargetDto[];
  /** 실행 요청에 그대로 붙여 보낼 값. 서버는 실행 직전 상태와 비교한다 */
  expected: CommandExpected;
  /** 실행하면 바뀔 트리거 상태. 비어 있으면 바뀌는 트리거가 없다 */
  changes: CommandChangeDto[];
  /** 실행하면 바뀔 그룹 일시정지 행 */
  groupChanges: CommandGroupChangeDto[];
  /** 실행하면 새로 넣을 트리거. 이름은 실행할 때 정한다 */
  inserts: CommandInsertDto[];
  /** 실행하면 바뀔 스케줄 */
  scheduleChanges: CommandScheduleChangeDto[];
  /** 실행하면 지울 트리거와 잡 */
  deletions: CommandDeletionDto;
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
  groupChanges: CommandGroupChangeDto[];
  /** 실제로 넣은 트리거(이름 포함) */
  inserts: CommandInsertDto[];
  scheduleChanges: CommandScheduleChangeDto[];
  deletions: CommandDeletionDto;
  /** 실행 결과에 붙는 안내(misfire 위임 등) */
  warnings: CommandNoticeDto[];
  /** 잠금 안에서 다시 읽은 실행 직전 상태 */
  before: CommandExpected;
  /** 같은 트랜잭션에서 읽은 실행 직후 상태 */
  after: CommandExpected;
  /** 남긴 감사 기록 ID */
  auditId: number;
}

/**
 * 일괄 제어 (FR-CTL-10, TRD §7.1 일괄 제어). 목록에서 고른 트리거나 잡을 한꺼번에 일시정지·재개한다.
 * 서버는 항목마다 단건 명령과 같은 절차(트랜잭션, 잠금, 감사 기록)로 하나씩 실행하고, 한 항목이 실패해도 다음 항목을 실행한다.
 */
export const batchCommandSchema = z.discriminatedUnion('type', [
  pauseTriggerCommandSchema,
  resumeTriggerCommandSchema,
  pauseJobCommandSchema,
  resumeJobCommandSchema,
]);
export type BatchCommand = z.infer<typeof batchCommandSchema>;
export type BatchCommandType = BatchCommand['type'];

/** 일괄 제어 한 번에 보낼 수 있는 항목 수. 목록 한 쪽(50개)을 모두 고를 수 있다 */
export const BATCH_ITEMS_MAX = 50;

/** `POST /schedulers/:id/commands/batch/preview` */
export const batchPreviewRequestSchema = z.object({
  commands: z.array(batchCommandSchema).min(1).max(BATCH_ITEMS_MAX),
});
export type BatchPreviewRequest = z.infer<typeof batchPreviewRequestSchema>;

/** `POST /schedulers/:id/commands/batch`. 항목마다 미리보기 응답의 `expected`를 붙인다 */
export const batchRequestSchema = z.object({
  items: z
    .array(z.object({ command: batchCommandSchema, expected: commandExpectedSchema }))
    .min(1)
    .max(BATCH_ITEMS_MAX),
});
export type BatchRequest = z.infer<typeof batchRequestSchema>;

/** 일괄 제어 항목 하나의 오류. 코드는 단건 명령의 오류 코드와 같다 */
export interface BatchItemErrorDto {
  code: string;
  message: string;
}

/** 항목 하나의 미리보기. 단건 미리보기에서 일시정지·재개에 필요한 부분이다 */
export interface BatchPreviewItemDto {
  command: BatchCommand;
  /** 대상을 읽었으면 그 결과. 읽지 못했으면(없어진 트리거 등) null이고 `error`에 이유가 있다 */
  preview: Pick<
    CommandPreviewResponse,
    'targets' | 'expected' | 'changes' | 'warnings' | 'blocked'
  > | null;
  error: BatchItemErrorDto | null;
}

export interface BatchPreviewResponse {
  dbNow: number;
  scheduler: CommandSchedulerDto;
  /** 접속 때문에 어떤 항목도 실행할 수 없는 이유(읽기 전용 등). 있으면 화면은 실행 버튼을 끈다 */
  blocked: CommandNoticeDto | null;
  /** 요청한 순서대로 */
  items: BatchPreviewItemDto[];
}

/**
 * 항목 하나의 실행 결과.
 * - `success`: 실행했다(바뀐 것이 없으면 `changed: false`)
 * - `failure`: 실행하지 못했다. 대상 DB는 바뀌지 않았고 감사 로그에 실패로 남았다
 * - `skipped`: 앞 항목에서 대상 DB에 연결할 수 없는 등 계속할 수 없는 오류가 나 실행하지 않았다(`BATCH_STOPPED`)
 */
export type BatchResultItemDto =
  | {
      command: BatchCommand;
      status: 'success';
      changed: boolean;
      changes: CommandChangeDto[];
      warnings: CommandNoticeDto[];
      auditId: number;
    }
  | { command: BatchCommand; status: 'failure' | 'skipped'; error: BatchItemErrorDto };

export interface BatchResultResponse {
  /** 이 일괄 실행의 ID. 항목별 감사 기록의 `before.batch.id`와 같다 */
  batchId: string;
  /** 요청한 순서대로 */
  items: BatchResultItemDto[];
}
