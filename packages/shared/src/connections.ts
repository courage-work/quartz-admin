/**
 * 접속·스케줄러 관리 API의 요청 스키마와 응답 타입 (TRD §5.7, PRD FR-CON)
 */
import { z } from 'zod';
import {
  DB_KINDS,
  type BoolFormat,
  type BoolFormatSource,
  type DbKind,
  type DetectionWarning,
  type MissingPrivilege,
  type QuartzFeatures,
  type QuartzTableKey,
  type SchedulerCandidate,
  type UnusableTableSet,
} from './quartz.js';
import type { SchedulerConnectionSummary, SnapshotDto } from './monitor.js';

/** 지금 연결할 수 있는 DB 종류. 나머지는 B-27~B-29에서 추가한다 */
export const SUPPORTED_DB_KINDS: readonly DbKind[] = ['oracle'];

export const CONNECTION_NAME_MAX = 100;
export const TAG_MAX = 30;
export const TAGS_MAX = 10;

const trimmed = (label: string, max: number) =>
  z
    .string({ error: `${label}을(를) 입력하세요` })
    .trim()
    .min(1, { error: `${label}을(를) 입력하세요` })
    .max(max, { error: `${label}은(는) ${max}자 이하여야 합니다` });

/** 비어 있으면 `undefined`로 본다. 화면 폼이 빈 문자열을 보내기 때문이다 */
const optionalTrimmed = (label: string, max: number, pattern?: RegExp, patternMessage?: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `${label}은(는) ${max}자 이하여야 합니다` })
    .refine((v) => v === '' || pattern === undefined || pattern.test(v), {
      error: patternMessage ?? `${label} 형식이 올바르지 않습니다`,
    })
    .transform((v) => (v === '' ? undefined : v))
    .optional();

/** 호스트 이름, IPv4, IPv6 */
const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;
/** Oracle 서비스 이름과 SID */
const ORACLE_NAME_PATTERN = /^[A-Za-z0-9._$#-]+$/;
/** 환경 라벨: prod, stage, dev 같은 짧은 소문자 */
const ENV_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const envLabelSchema = z
  .string({ error: '환경 라벨을 입력하세요' })
  .trim()
  .toLowerCase()
  .min(1, { error: '환경 라벨을 입력하세요' })
  .max(20, { error: '환경 라벨은 20자 이하여야 합니다' })
  .regex(ENV_LABEL_PATTERN, { error: '환경 라벨은 영문 소문자, 숫자, -, _로 씁니다(예: prod)' });

export const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, { error: '빈 태그는 쓸 수 없습니다' })
      .max(TAG_MAX, { error: `태그는 ${TAG_MAX}자 이하여야 합니다` }),
  )
  .max(TAGS_MAX, { error: `태그는 ${TAGS_MAX}개까지 붙일 수 있습니다` })
  .transform((tags) => [...new Set(tags)]);

/** 접속 정보 중 대상 DB에 연결하는 데 쓰는 값 (FR-CON-01) */
const targetFields = {
  dbType: z.enum(DB_KINDS, { error: 'DB 종류를 고르세요' }),
  host: trimmed('호스트', 253).regex(HOST_PATTERN, {
    error: '호스트는 이름이나 IP 주소로 입력하세요',
  }),
  port: z.coerce
    .number({ error: '포트를 입력하세요' })
    .int({ error: '포트는 정수여야 합니다' })
    .min(1, { error: '포트는 1~65535 사이여야 합니다' })
    .max(65_535, { error: '포트는 1~65535 사이여야 합니다' }),
  database: optionalTrimmed('DB 이름', 128),
  oracleServiceName: optionalTrimmed(
    '서비스 이름',
    128,
    ORACLE_NAME_PATTERN,
    '서비스 이름에는 영문, 숫자, ., _, $, #, -만 쓸 수 있습니다',
  ),
  oracleSid: optionalTrimmed(
    'SID',
    128,
    ORACLE_NAME_PATTERN,
    'SID에는 영문, 숫자, ., _, $, #, -만 쓸 수 있습니다',
  ),
  schemaName: optionalTrimmed('스키마', 128, /^[^"`]+$/, '스키마 이름에 따옴표는 쓸 수 없습니다'),
  username: trimmed('계정', 128),
};

/** 비밀번호. 앞뒤 공백도 비밀번호의 일부일 수 있으므로 자르지 않는다 */
const passwordField = z
  .string({ error: '비밀번호를 입력하세요' })
  .min(1, { error: '비밀번호를 입력하세요' })
  .max(1_024, { error: '비밀번호가 너무 깁니다' });

type TargetFieldsValue = {
  dbType: DbKind;
  database?: string | undefined;
  oracleServiceName?: string | undefined;
  oracleSid?: string | undefined;
};

/** DB 종류별 필수 입력. Oracle은 서비스 이름과 SID 중 하나, 나머지는 DB 이름 */
function checkTargetFields(value: TargetFieldsValue, ctx: z.RefinementCtx): void {
  if (!SUPPORTED_DB_KINDS.includes(value.dbType)) {
    ctx.addIssue({
      code: 'custom',
      path: ['dbType'],
      message: '아직 지원하지 않는 DB 종류입니다. 지금은 Oracle만 연결할 수 있습니다',
    });
    return;
  }
  if (value.dbType === 'oracle') {
    const both = value.oracleServiceName !== undefined && value.oracleSid !== undefined;
    const none = value.oracleServiceName === undefined && value.oracleSid === undefined;
    if (both || none) {
      ctx.addIssue({
        code: 'custom',
        path: ['oracleServiceName'],
        message: '서비스 이름과 SID 중 하나만 입력하세요',
      });
    }
  } else if (value.database === undefined) {
    ctx.addIssue({ code: 'custom', path: ['database'], message: 'DB 이름을 입력하세요' });
  }
}

const connectionFields = {
  name: trimmed('접속 이름', CONNECTION_NAME_MAX),
  ...targetFields,
  envLabel: envLabelSchema,
  tags: tagsSchema.default([]),
  readOnly: z.boolean().default(false),
};

/** `POST /connections` (FR-CON-01) */
export const createConnectionRequestSchema = z
  .object({ ...connectionFields, password: passwordField })
  .superRefine(checkTargetFields);
export type CreateConnectionRequest = z.input<typeof createConnectionRequestSchema>;
export type CreateConnectionInput = z.output<typeof createConnectionRequestSchema>;

/**
 * `PUT /connections/:id` (FR-CON-05). 접속 정보 전체를 다시 보낸다.
 * `password`를 빼거나 비워 두면 저장된 비밀번호를 그대로 쓴다.
 */
export const updateConnectionRequestSchema = z
  .object({
    ...connectionFields,
    password: z
      .string()
      .max(1_024, { error: '비밀번호가 너무 깁니다' })
      .transform((v) => (v === '' ? undefined : v))
      .optional(),
  })
  .superRefine(checkTargetFields);
export type UpdateConnectionRequest = z.input<typeof updateConnectionRequestSchema>;
export type UpdateConnectionInput = z.output<typeof updateConnectionRequestSchema>;

/**
 * `POST /connections/test` (FR-CON-02). 저장하기 전에 연결을 시험한다.
 * `connectionId`를 주고 `password`를 비워 두면 저장된 비밀번호로 시험한다(수정 화면).
 */
export const testConnectionRequestSchema = z
  .object({
    ...targetFields,
    password: z
      .string()
      .max(1_024, { error: '비밀번호가 너무 깁니다' })
      .transform((v) => (v === '' ? undefined : v))
      .optional(),
    connectionId: z.coerce.number().int().positive().optional(),
  })
  .superRefine(checkTargetFields)
  .refine((v) => v.password !== undefined || v.connectionId !== undefined, {
    error: '비밀번호를 입력하세요',
    path: ['password'],
  });
export type TestConnectionRequest = z.input<typeof testConnectionRequestSchema>;
export type TestConnectionInput = z.output<typeof testConnectionRequestSchema>;

/** 접속. 비밀번호는 응답에 아예 없다 (FR-CON-06) */
export interface ConnectionDto {
  id: number;
  name: string;
  dbType: DbKind;
  host: string;
  port: number;
  database: string | null;
  oracleServiceName: string | null;
  oracleSid: string | null;
  schemaName: string | null;
  username: string;
  envLabel: string;
  tags: string[];
  /** 사용자가 지정한 읽기 전용 */
  readOnly: boolean;
  /** 마지막 감지에서 확인한 쓰기 권한. null이면 아직 감지하지 않음 */
  writeCapable: boolean | null;
  schedulerCount: number;
  createdAt: number;
  updatedAt: number;
}

/** 연결 테스트 결과. 실패도 200으로 돌려주고 화면이 원인을 보여준다 */
export type ConnectionTestResult =
  | {
      ok: true;
      durationMs: number;
      /** 감지한 스키마 */
      schema: string;
      /** 쓸 수 있는 Quartz 테이블 세트 수 */
      tableSetCount: number;
      /** 모든 테이블 세트의 SCHED_NAME 후보 수 */
      schedulerCount: number;
      /** 테이블 세트가 하나 이상이고 모두 쓰기 가능하면 true. 세트가 없으면 null */
      writeCapable: boolean | null;
    }
  | {
      ok: false;
      durationMs: number;
      /** `TARGET_UNREACHABLE`, `TARGET_AUTH_FAILED`, `TARGET_TIMEOUT`, `TARGET_BUSY`, `TARGET_ERROR` */
      code: string;
      message: string;
    };

/** 스케줄러 후보 하나. 이미 등록된 스케줄러면 그 ID가 붙는다 */
export interface SchedulerCandidateDto extends SchedulerCandidate {
  registeredSchedulerId: number | null;
}

export interface DetectedTableSetDto {
  prefix: string;
  tableNames: Partial<Record<QuartzTableKey, string>>;
  features: QuartzFeatures;
  boolFormat: BoolFormat;
  boolFormatSource: BoolFormatSource;
  writeCapable: boolean;
  missingPrivileges: MissingPrivilege[];
  warnings: DetectionWarning[];
  schedulers: SchedulerCandidateDto[];
}

/** `POST /connections/:id/detect` 응답 (FR-CON-03, 05) */
export interface DetectionDto {
  connectionId: number;
  schema: string;
  dbNow: number;
  tableSets: DetectedTableSetDto[];
  unusable: UnusableTableSet[];
  /** 이번 감지로 테이블 이름·기능·불리언 형식을 갱신한 등록 스케줄러 */
  refreshedSchedulerIds: number[];
  /** 등록돼 있지만 이번 감지에서 찾지 못한 스케줄러. 테이블이 지워졌거나 권한이 바뀐 경우다 */
  missingSchedulerIds: number[];
}

/** `POST /connections/:id/schedulers` (FR-CON-03). 감지 결과에서 고른 후보를 등록한다 */
export const registerSchedulersRequestSchema = z.object({
  selections: z
    .array(
      z.object({
        prefix: z.string().max(128),
        schedName: z.string().min(1).max(120),
        displayName: optionalTrimmed('표시 이름', 100),
      }),
    )
    .min(1, { error: '등록할 스케줄러를 하나 이상 고르세요' })
    .max(50),
});
export type RegisterSchedulersRequest = z.input<typeof registerSchedulersRequestSchema>;
export type RegisterSchedulersInput = z.output<typeof registerSchedulersRequestSchema>;

/** 감시 파라미터 범위 (FR-CON-07) */
export const SCHEDULER_SETTING_LIMITS = {
  misfireThresholdMs: { min: 1_000, max: 3_600_000 },
  overdueGraceMs: { min: 1_000, max: 3_600_000 },
  checkinMultiplier: { min: 2, max: 20 },
  expectedNodeCount: { min: 0, max: 100 },
  pollIntervalSec: { min: 15, max: 3_600 },
} as const;

const limited = (key: keyof typeof SCHEDULER_SETTING_LIMITS, label: string) => {
  const { min, max } = SCHEDULER_SETTING_LIMITS[key];
  return z.coerce
    .number({ error: `${label}을(를) 입력하세요` })
    .int({ error: `${label}은(는) 정수여야 합니다` })
    .min(min, { error: `${label}은(는) ${min} 이상이어야 합니다` })
    .max(max, { error: `${label}은(는) ${max} 이하여야 합니다` });
};

/**
 * `PUT /schedulers/:id/settings` (FR-CON-07).
 * 연체 유예(`overdueGraceMs`)는 misfire 임계값보다 작으면 정상 클러스터에서도 오탐이 나므로 막는다 (TRD §9.2)
 */
export const schedulerSettingsSchema = z
  .object({
    displayName: trimmed('표시 이름', 100),
    misfireThresholdMs: limited('misfireThresholdMs', 'misfire 임계값'),
    overdueGraceMs: limited('overdueGraceMs', '연체 유예 시간'),
    checkinMultiplier: limited('checkinMultiplier', '체크인 판정 배수'),
    expectedNodeCount: limited('expectedNodeCount', '기대 노드 수'),
    pollIntervalSec: limited('pollIntervalSec', '감시 주기'),
  })
  .refine((v) => v.overdueGraceMs >= v.misfireThresholdMs, {
    error: '연체 유예 시간은 misfire 임계값 이상이어야 합니다',
    path: ['overdueGraceMs'],
  });
export type SchedulerSettings = z.infer<typeof schedulerSettingsSchema>;

export interface SchedulerDto extends SchedulerSettings {
  id: number;
  connectionId: number;
  tablePrefix: string;
  /** 감지한 테이블 소유 스키마. 이 필드가 생기기 전에 등록한 스케줄러는 다시 감지하기 전까지 null */
  tableSchema: string | null;
  schedName: string;
  tableNames: Partial<Record<QuartzTableKey, string>>;
  features: QuartzFeatures;
  boolFormat: BoolFormat;
  detectedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** `GET /schedulers/:id`. 설정·감지 정보에 접속 요약, 마지막 스냅샷, 열린 알림 수를 붙인다 (TRD §8.1) */
export interface SchedulerDetailDto extends SchedulerDto {
  connection: SchedulerConnectionSummary;
  snapshot: SnapshotDto | null;
  openAlertCount: number;
}

/** 삭제 영향 미리보기 (FR-CON-05) */
export interface DeleteImpactDto {
  schedulers: { id: number; displayName: string; schedName: string }[];
  alertRuleCount: number;
  openAlertCount: number;
}
