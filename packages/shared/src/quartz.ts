/**
 * Quartz 대상 DB와 자동 감지 결과의 공용 타입 (TRD §5.1, §5.5).
 * `@qa/store`가 이 값을 만들고, API 응답과 화면이 같은 타입을 쓴다.
 */

/** 지원 대상 DB 종류 (TRD §5.1) */
export const DB_KINDS = ['oracle', 'postgresql', 'mysql', 'mariadb'] as const;

export type DbKind = (typeof DB_KINDS)[number];

export function isDbKind(value: unknown): value is DbKind {
  return typeof value === 'string' && (DB_KINDS as readonly string[]).includes(value);
}

/** Quartz 2.x JDBC JobStore 테이블(prefix 제외). 자동 감지의 필수·선택 세트 (TRD §5.5) */
export const QUARTZ_REQUIRED_TABLES = [
  'JOB_DETAILS',
  'TRIGGERS',
  'SIMPLE_TRIGGERS',
  'CRON_TRIGGERS',
  'BLOB_TRIGGERS',
  'CALENDARS',
  'PAUSED_TRIGGER_GRPS',
  'FIRED_TRIGGERS',
  'SCHEDULER_STATE',
  'LOCKS',
] as const;

export const QUARTZ_OPTIONAL_TABLES = ['SIMPROP_TRIGGERS'] as const;

export type QuartzRequiredTable = (typeof QUARTZ_REQUIRED_TABLES)[number];
export type QuartzOptionalTable = (typeof QUARTZ_OPTIONAL_TABLES)[number];
export type QuartzTableKey = QuartzRequiredTable | QuartzOptionalTable;

export const QUARTZ_TABLE_KEYS: readonly QuartzTableKey[] = [
  ...QUARTZ_REQUIRED_TABLES,
  ...QUARTZ_OPTIONAL_TABLES,
];

export function isQuartzTableKey(value: string): value is QuartzTableKey {
  return (QUARTZ_TABLE_KEYS as readonly string[]).includes(value);
}

/**
 * 불리언 저장 형식 (TRD §5.5 4단계, NFR-COMP-03). 메타 저장소 `schedulers.bool_format` 값이다.
 * `native`는 BOOLEAN 컬럼, 나머지는 문자 컬럼에 저장된 참/거짓 값 쌍이다.
 */
export const BOOL_FORMATS = ['native', '10', 'YN', 'TF'] as const;
export type BoolFormat = (typeof BOOL_FORMATS)[number];

/** 불리언 형식을 무엇으로 정했는지. `default`는 판정할 값이 없어 Quartz 기본 동작(`'1'`/`'0'`)으로 본 경우다 */
export type BoolFormatSource = 'column-type' | 'values' | 'default';

/**
 * Quartz 버전마다 다른 선택 테이블·컬럼 (TRD §5.5 3단계). 메타 저장소 `schedulers.features_json` 값이다.
 * 쿼리 빌더는 이 값에 따라 컬럼을 넣거나 뺀다.
 */
export interface QuartzFeatures {
  /** `SIMPROP_TRIGGERS` 테이블 (2.1 이상) */
  simpropTriggers: boolean;
  /** `TRIGGERS.PRIORITY` */
  triggerPriority: boolean;
  /** `FIRED_TRIGGERS.PRIORITY` */
  firedPriority: boolean;
  /** `FIRED_TRIGGERS.SCHED_TIME` (2.2 이상) */
  firedSchedTime: boolean;
  /** `JOB_DETAILS.IS_NONCONCURRENT` */
  jobNonconcurrent: boolean;
  /** `JOB_DETAILS.IS_UPDATE_DATA` */
  jobUpdateData: boolean;
  /** `CRON_TRIGGERS.TIME_ZONE_ID` */
  cronTimeZone: boolean;
}

export type QuartzFeatureKey = keyof QuartzFeatures;

/** 쓰기 권한 점검에서 확인하는 권한 */
export type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface MissingPrivilege {
  table: QuartzTableKey;
  privilege: TablePrivilege;
  /** 드라이버 오류 코드(`ORA-01031` 등) */
  driverCode?: string | undefined;
}

/** 한 테이블 세트 안의 SCHED_NAME 하나. 화면에서 스케줄러 후보로 보여준다 */
export interface SchedulerCandidate {
  schedName: string;
  jobCount: number;
  triggerCount: number;
  /** `SCHEDULER_STATE` 행 수 */
  nodeCount: number;
  /** 체크인이 살아 있는 노드 수 (TRD §9.2 활성 노드 정의) */
  activeNodeCount: number;
  /** `schedulers.expected_node_count` 초기값 (§5.5 7단계) */
  expectedNodeCount: number;
}

/** 감지 결과를 해석할 때 참고할 경고 */
export type DetectionWarning =
  /** 불리언 컬럼에 형식이 다른 값이 섞여 있음. 가장 많이 보이는 형식을 골랐다 */
  | 'BOOL_FORMAT_MIXED'
  /** 불리언 컬럼에 알아볼 수 없는 값이 있음 */
  | 'BOOL_FORMAT_UNKNOWN_VALUE';

/** 감지한 Quartz 테이블 세트 하나(prefix 하나) */
export interface DetectedTableSet {
  /** 실제 테이블 이름의 prefix. 대소문자를 그대로 둔다(`QRTZ_`, `qrtz_`) */
  prefix: string;
  /** 논리 이름 → 실제 테이블 이름. 필수 테이블은 모두 있고, 선택 테이블은 있을 때만 들어간다 */
  tableNames: Partial<Record<QuartzTableKey, string>>;
  features: QuartzFeatures;
  boolFormat: BoolFormat;
  boolFormatSource: BoolFormatSource;
  /** 도구의 쓰기 명령에 필요한 권한이 모두 있는지 (FR-CON-04) */
  writeCapable: boolean;
  missingPrivileges: MissingPrivilege[];
  schedulers: SchedulerCandidate[];
  warnings: DetectionWarning[];
}

/** 테이블 세트로 쓸 수 없는 prefix. 화면에서 이유와 함께 보여준다 */
export interface UnusableTableSet {
  prefix: string;
  reason: 'MISSING_TABLES' | 'NO_SCHED_NAME';
  /** `MISSING_TABLES`면 빠진 필수 테이블, `NO_SCHED_NAME`이면 SCHED_NAME 컬럼이 없는 테이블(Quartz 1.x) */
  tables: QuartzTableKey[];
}

export interface QuartzDetection {
  /** 감지한 스키마(Oracle OWNER) */
  schema: string;
  /** 감지 시점의 DB 현재 시각(epoch ms). 활성 노드 판정 기준 */
  dbNow: number;
  tableSets: DetectedTableSet[];
  unusable: UnusableTableSet[];
}

/** QRTZ_TRIGGERS.TRIGGER_STATE 값 (Quartz 2.x `org.quartz.impl.jdbcjobstore.Constants`) */
export const TRIGGER_STATES = [
  'WAITING',
  'ACQUIRED',
  'EXECUTING',
  'COMPLETE',
  'BLOCKED',
  'ERROR',
  'PAUSED',
  'PAUSED_BLOCKED',
  'DELETED',
] as const;
export type TriggerState = (typeof TRIGGER_STATES)[number];

export function isTriggerState(value: unknown): value is TriggerState {
  return typeof value === 'string' && (TRIGGER_STATES as readonly string[]).includes(value);
}

/** QRTZ_TRIGGERS.TRIGGER_TYPE 값 (`Constants.TTYPE_*`) */
export const TRIGGER_TYPES = ['SIMPLE', 'CRON', 'CAL_INT', 'DAILY_I', 'BLOB'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
