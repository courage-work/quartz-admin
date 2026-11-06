/**
 * 메타데이터 저장소 스키마 (TRD §3.2)
 *
 * - 컬럼명은 drizzle `casing: 'snake_case'`로 TS camelCase → DB snake_case 변환
 * - 시각은 모두 epoch milliseconds 정수 (Quartz 컬럼과 같은 단위)
 * - JSON 컬럼은 TEXT에 저장
 * - 단일 인스턴스 락(`instance_lock`)은 마이그레이션보다 먼저 필요하므로 이 스키마에 두지 않는다
 *   (instance-lock.ts에서 직접 생성)
 */
import {
  ALERT_RULE_TYPES,
  ALERT_STATUSES,
  AUDIT_RESULTS,
  CHANNEL_TYPES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_STATUSES,
  SCHEDULER_HEALTH,
  SEVERITIES,
  type QuartzFeatures,
  type QuartzTableKey,
} from '@qa/shared';
import { BOOL_FORMATS, DB_KINDS } from '@qa/store';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export type AlertScope =
  | { kind: 'all' }
  | { kind: 'groups'; groups: string[] }
  | { kind: 'triggers'; triggers: { group: string; name: string }[] };

export interface NodeSnapshot {
  instanceName: string;
  lastCheckinTime: number;
  checkinInterval: number;
  active: boolean;
}

const id = () => integer().primaryKey({ autoIncrement: true });
const createdAt = () => integer().notNull();
const updatedAt = () => integer().notNull();

// ── 사용자와 세션 ────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: id(),
  username: text().notNull().unique(),
  passwordHash: text().notNull(),
  isAdmin: integer({ mode: 'boolean' }).notNull().default(false),
  isActive: integer({ mode: 'boolean' }).notNull().default(true),
  failedLoginCount: integer().notNull().default(0),
  lockedUntil: integer(),
  lastLoginAt: integer(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** 세션 토큰의 SHA-256 hex. 원본 토큰은 쿠키에만 존재 */
    id: text().primaryKey(),
    userId: integer()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
    lastSeenAt: integer().notNull(),
    expiresAt: integer().notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

// ── 접속과 스케줄러 ──────────────────────────────────────────────

export const connections = sqliteTable('connections', {
  id: id(),
  name: text().notNull().unique(),
  dbType: text({ enum: DB_KINDS }).notNull(),
  host: text().notNull(),
  port: integer().notNull(),
  database: text(),
  oracleServiceName: text(),
  oracleSid: text(),
  schemaName: text(),
  username: text().notNull(),
  /** `v1:<keyId>:<iv>:<tag>:<ciphertext>` (TRD §4.1) */
  passwordEnc: text().notNull(),
  options: text({ mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  envLabel: text().notNull(),
  tags: text({ mode: 'json' })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  /** 사용자가 지정한 읽기 전용 */
  readOnly: integer({ mode: 'boolean' }).notNull().default(false),
  /** 자동 감지한 쓰기 권한. null = 아직 점검 안 함 */
  writeCapable: integer({ mode: 'boolean' }),
  createdBy: integer().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const schedulers = sqliteTable(
  'schedulers',
  {
    id: id(),
    connectionId: integer()
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    tablePrefix: text().notNull(),
    /** 논리 테이블명(TRIGGERS 등) → 감지한 실제 테이블명 */
    tableNames: text({ mode: 'json' }).$type<Partial<Record<QuartzTableKey, string>>>().notNull(),
    schedName: text().notNull(),
    displayName: text().notNull(),
    /** 선택 테이블·컬럼 존재 여부 (SIMPROP_TRIGGERS, FIRED_TRIGGERS.SCHED_TIME 등) */
    features: text({ mode: 'json' }).$type<QuartzFeatures>().notNull(),
    boolFormat: text({ enum: BOOL_FORMATS }).notNull(),
    misfireThresholdMs: integer().notNull().default(60_000),
    overdueGraceMs: integer().notNull().default(60_000),
    checkinMultiplier: integer().notNull().default(3),
    expectedNodeCount: integer().notNull(),
    pollIntervalSec: integer().notNull().default(60),
    mutedUntil: integer(),
    detectedAt: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('schedulers_identity_uq').on(t.connectionId, t.tablePrefix, t.schedName)],
);

/** 감시 루프가 저장하는 대시보드 캐시 (TRD §8.4) */
export const schedulerSnapshots = sqliteTable('scheduler_snapshots', {
  schedulerId: integer()
    .primaryKey()
    .references(() => schedulers.id, { onDelete: 'cascade' }),
  polledAt: integer().notNull(),
  dbNow: integer(),
  clockSkewMs: integer(),
  status: text({ enum: SCHEDULER_HEALTH }).notNull(),
  triggerCounts: text({ mode: 'json' }).$type<Record<string, number>>(),
  nodes: text({ mode: 'json' }).$type<NodeSnapshot[]>(),
  executingCount: integer(),
  errorCode: text(),
  errorMessage: text(),
  consecutiveFailures: integer().notNull().default(0),
});

export const knownNodes = sqliteTable(
  'known_nodes',
  {
    schedulerId: integer()
      .notNull()
      .references(() => schedulers.id, { onDelete: 'cascade' }),
    instanceName: text().notNull(),
    firstSeenAt: integer().notNull(),
    lastSeenAt: integer().notNull(),
    lastCheckinTime: integer(),
    checkinInterval: integer(),
  },
  (t) => [primaryKey({ columns: [t.schedulerId, t.instanceName] })],
);

/** BLOCKED 지속 시간 추적. 재시작해도 유지 (TRD §9.2) */
export const triggerObservations = sqliteTable(
  'trigger_observations',
  {
    schedulerId: integer()
      .notNull()
      .references(() => schedulers.id, { onDelete: 'cascade' }),
    triggerGroup: text().notNull(),
    triggerName: text().notNull(),
    state: text().notNull(),
    firstSeenAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.schedulerId, t.triggerGroup, t.triggerName] })],
);

// ── 알림 ─────────────────────────────────────────────────────────

export const channels = sqliteTable('channels', {
  id: id(),
  type: text({ enum: CHANNEL_TYPES }).notNull(),
  name: text().notNull(),
  /** 웹훅 URL, 수신자 등. 비밀값이므로 암호화 (TRD §4.1) */
  configEnc: text().notNull(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const alertRules = sqliteTable(
  'alert_rules',
  {
    id: id(),
    schedulerId: integer()
      .notNull()
      .references(() => schedulers.id, { onDelete: 'cascade' }),
    type: text({ enum: ALERT_RULE_TYPES }).notNull(),
    params: text({ mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    scope: text({ mode: 'json' })
      .$type<AlertScope>()
      .notNull()
      .$defaultFn(() => ({ kind: 'all' })),
    severity: text({ enum: SEVERITIES }).notNull(),
    /** null = 재알림 안 함 */
    renotifyMinutes: integer(),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('alert_rules_scheduler_idx').on(t.schedulerId)],
);

export const alertRuleChannels = sqliteTable(
  'alert_rule_channels',
  {
    ruleId: integer()
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    channelId: integer()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.channelId] })],
);

export const alerts = sqliteTable(
  'alerts',
  {
    id: id(),
    schedulerId: integer()
      .notNull()
      .references(() => schedulers.id, { onDelete: 'cascade' }),
    ruleId: integer().references(() => alertRules.id, { onDelete: 'set null' }),
    fingerprint: text().notNull(),
    type: text({ enum: ALERT_RULE_TYPES }).notNull(),
    severity: text({ enum: SEVERITIES }).notNull(),
    status: text({ enum: ALERT_STATUSES }).notNull(),
    affected: text({ mode: 'json' }).$type<unknown>(),
    firstSeenAt: integer().notNull(),
    lastSeenAt: integer().notNull(),
    resolvedAt: integer(),
    ackedBy: integer().references(() => users.id, { onDelete: 'set null' }),
    ackedAt: integer(),
    lastNotifiedAt: integer(),
  },
  (t) => [
    index('alerts_scheduler_status_idx').on(t.schedulerId, t.status),
    // 열린(해소 전) 알림은 (규칙, 지문)마다 하나만 존재 (TRD §3.2)
    uniqueIndex('alerts_open_fingerprint_uq')
      .on(t.ruleId, t.fingerprint)
      .where(sql`status <> 'resolved'`),
  ],
);

export const alertReads = sqliteTable(
  'alert_reads',
  {
    alertId: integer()
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    userId: integer()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.alertId, t.userId] })],
);

/** 발송 큐(outbox) (TRD §9.4) */
export const notifications = sqliteTable(
  'notifications',
  {
    id: id(),
    alertId: integer()
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    channelId: integer()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    event: text({ enum: NOTIFICATION_EVENTS }).notNull(),
    status: text({ enum: NOTIFICATION_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer().notNull(),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_due_idx').on(t.status, t.nextAttemptAt)],
);

// ── 감사 로그와 설정 ─────────────────────────────────────────────

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: id(),
    at: integer().notNull(),
    userId: integer().references(() => users.id, { onDelete: 'set null' }),
    /** 사용자 삭제·이름 변경 후에도 남도록 당시 이름을 함께 기록 */
    username: text(),
    ip: text(),
    requestId: text(),
    action: text().notNull(),
    targetType: text(),
    target: text({ mode: 'json' }).$type<unknown>(),
    // 접속·스케줄러가 삭제돼도 기록이 남아야 하므로 외래키를 걸지 않는다
    connectionId: integer(),
    schedulerId: integer(),
    before: text({ mode: 'json' }).$type<unknown>(),
    after: text({ mode: 'json' }).$type<unknown>(),
    result: text({ enum: AUDIT_RESULTS }).notNull(),
    errorCode: text(),
    errorMessage: text(),
    reason: text(),
  },
  (t) => [
    index('audit_logs_at_idx').on(t.at),
    index('audit_logs_scheduler_at_idx').on(t.schedulerId, t.at),
    index('audit_logs_user_at_idx').on(t.userId, t.at),
  ],
);

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: updatedAt(),
});
