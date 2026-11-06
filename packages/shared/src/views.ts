/**
 * 스케줄러 조회 API의 요청 스키마와 응답 타입 (TRD §8.1, PRD FR-VIEW-02~05, 08)
 * 모든 응답은 데이터를 읽은 대상 DB 시각 `dbNow`(epoch ms)를 함께 돌려준다(FR-VIEW-06).
 */
import { z } from 'zod';
import { TRIGGER_STATES, TRIGGER_TYPES } from './quartz.js';

export const VIEW_PAGE_SIZE_DEFAULT = 50;
export const VIEW_PAGE_SIZE_MAX = 200;

/** Quartz 이름 컬럼 길이(VARCHAR2(200)). 그룹·이름 조건은 이 길이까지 받는다 */
const NAME_MAX = 200;

/** 쿼리 문자열의 반복 값(`state=A&state=B`)과 쉼표 값(`state=A,B`)을 배열로 받는다 */
const listParam = <T extends string>(values: readonly [T, ...T[]]) =>
  z.preprocess(
    (raw) => {
      if (raw === undefined || raw === '') return undefined;
      const list = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v).split(','));
      return list.map((v) => v.trim()).filter((v) => v !== '');
    },
    z.array(z.enum(values)).max(values.length).optional(),
  );

const pageFields = {
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(VIEW_PAGE_SIZE_MAX).default(VIEW_PAGE_SIZE_DEFAULT),
};

/** 그룹은 정확히 일치, 검색어는 이름·그룹 부분 일치(대소문자 무시). `%`, `_`도 글자 그대로 찾는다 */
const groupParam = z.string().min(1).max(NAME_MAX).optional();
const searchParam = z
  .string()
  .trim()
  .max(NAME_MAX)
  .transform((v) => (v === '' ? undefined : v))
  .optional();

/** `GET /schedulers/:id/jobs` */
export const jobListQuerySchema = z.object({
  group: groupParam,
  q: searchParam,
  ...pageFields,
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const TRIGGER_SORTS = ['key', 'nextFireTime'] as const;
export type TriggerSort = (typeof TRIGGER_SORTS)[number];

/** `GET /schedulers/:id/triggers` */
export const triggerListQuerySchema = z.object({
  state: listParam(TRIGGER_STATES),
  type: listParam(TRIGGER_TYPES),
  group: groupParam,
  q: searchParam,
  sort: z.enum(TRIGGER_SORTS).default('key'),
  ...pageFields,
});
export type TriggerListQuery = z.infer<typeof triggerListQuerySchema>;

/** `GET /schedulers/:id/jobs/detail?group=&name=`. 키에 `/`가 들어갈 수 있어 경로가 아니라 쿼리로 받는다 */
export const jobKeyQuerySchema = z.object({
  group: z.string({ error: '잡 그룹이 필요합니다' }).min(1).max(NAME_MAX),
  name: z.string({ error: '잡 이름이 필요합니다' }).min(1).max(NAME_MAX),
});
export type JobKeyQuery = z.infer<typeof jobKeyQuerySchema>;

export interface Page<T> {
  dbNow: number;
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** 클러스터 노드 (FR-VIEW-02). 활성 판정은 TRD §9.2와 같다 */
export interface NodeDto {
  instanceName: string;
  lastCheckinTime: number | null;
  checkinInterval: number;
  /** `LAST_CHECKIN_TIME + CHECKIN_INTERVAL × checkin_multiplier ≥ dbNow` */
  active: boolean;
  /** dbNow - 마지막 체크인(ms) */
  sinceCheckinMs: number | null;
}

export interface NodesResponse {
  dbNow: number;
  checkinMultiplier: number;
  nodes: NodeDto[];
}

export interface PausedGroupsResponse {
  dbNow: number;
  /** `_$_ALL_GROUPS_PAUSED_$_`는 pauseAll 표시이며 `allPaused`로 따로 알린다 */
  groups: string[];
  allPaused: boolean;
}

/** 잡 (FR-VIEW-03) */
export interface JobDto {
  group: string;
  name: string;
  jobClass: string;
  description: string | null;
  durable: boolean | null;
  /** 동시 실행 금지(`@DisallowConcurrentExecution`). 컬럼이 없는 스키마면 null */
  nonConcurrent: boolean | null;
  updateData: boolean | null;
  requestsRecovery: boolean | null;
  triggerCount: number;
}

export interface CronScheduleDto {
  expression: string;
  /** Java TimeZone ID. 없으면 Quartz는 JVM 기본 타임존을 쓴다 */
  timeZone: string | null;
}

export interface SimpleScheduleDto {
  /** -1이면 무한 반복 */
  repeatCount: number;
  repeatIntervalMs: number;
  timesTriggered: number;
}

/** CAL_INT·DAILY_I 트리거의 원본 속성. 화면은 표시만 한다 */
export interface SimpropDto {
  strings: (string | null)[];
  ints: (number | null)[];
  longs: (number | null)[];
  decimals: (number | null)[];
  bools: (boolean | null)[];
}

/** 트리거 (FR-VIEW-04) */
export interface TriggerDto {
  group: string;
  name: string;
  jobGroup: string;
  jobName: string;
  description: string | null;
  /** `TRIGGER_TYPES` 값. 사용자 정의 트리거면 다른 값이 올 수 있어 문자열로 둔다 */
  type: string;
  /** `TRIGGER_STATES` 값 */
  state: string;
  nextFireTime: number | null;
  prevFireTime: number | null;
  startTime: number | null;
  endTime: number | null;
  priority: number | null;
  /** Quartz `MISFIRE_INSTR` 원래 값. 의미는 트리거 타입마다 다르다 */
  misfireInstruction: number | null;
  calendarName: string | null;
  cron: CronScheduleDto | null;
  simple: SimpleScheduleDto | null;
  simprop: SimpropDto | null;
}

/** JobDataMap 표시 (FR-VIEW-08, TRD §8.3) */
export type JobDataDto =
  | { format: 'empty' }
  | { format: 'properties'; entries: { key: string; value: string }[] }
  | { format: 'java-serialized'; bytes: number }
  | { format: 'unreadable'; bytes: number };

export interface JobDetailResponse {
  dbNow: number;
  job: JobDto;
  triggers: TriggerDto[];
  jobData: JobDataDto;
}

/** 실행 중이거나 획득된 트리거 (FR-VIEW-05) */
export interface ExecutingDto {
  entryId: string;
  triggerGroup: string;
  triggerName: string;
  jobGroup: string | null;
  jobName: string | null;
  instanceName: string;
  /** `EXECUTING` 또는 `ACQUIRED`(그 밖에 `BLOCKED`, `PAUSED_BLOCKED`) */
  state: string;
  firedTime: number | null;
  /** 원래 예정 시각. 2.2 미만 스키마면 null */
  scheduledTime: number | null;
  priority: number | null;
  nonConcurrent: boolean | null;
  requestsRecovery: boolean | null;
  /** dbNow - firedTime */
  elapsedMs: number | null;
  /** 활성 노드가 아닌 인스턴스의 기록. ClusterManager가 복구하기 전이거나 클러스터가 내려간 경우다 */
  stale: boolean;
}

export interface ExecutingResponse {
  dbNow: number;
  items: ExecutingDto[];
}
