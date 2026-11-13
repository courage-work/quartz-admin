/**
 * 감시 루프와 대시보드 스냅샷 (TRD §8.4, §9.1)
 */
import { z } from 'zod';
import type { SchedulerHealth } from './domain.js';
import type { DbKind } from './quartz.js';
import type { NodeDto } from './views.js';

export interface TriggerRef {
  group: string;
  name: string;
}

/** 감시 1회에 대상 DB에서 읽은 값. 스냅샷 저장과 알림 규칙 평가(B-24)가 함께 쓴다 */
export interface MonitorData {
  dbNow: number;
  /** TRIGGER_STATE → 개수 */
  triggerCounts: Record<string, number>;
  nodes: NodeDto[];
  /** FIRED_TRIGGERS 행 수 */
  executingCount: number;
  /** WAITING·ACQUIRED이면서 `misfire_threshold_ms + overdue_grace_ms`보다 오래 밀린 트리거 수 */
  overdueCount: number;
  /** 가장 오래 밀린 순서로 최대 500개 */
  overdue: (TriggerRef & { nextFireTime: number })[];
  errorTriggers: TriggerRef[];
  /** BLOCKED, PAUSED_BLOCKED */
  blockedTriggers: (TriggerRef & { state: string })[];
}

/** 대시보드 캐시 한 행 (`scheduler_snapshots`) */
export interface SnapshotDto {
  schedulerId: number;
  /** 마지막 감시 시각(도구 서버 기준) */
  polledAt: number;
  status: SchedulerHealth;
  /** 마지막으로 성공한 감시의 DB 시각. 한 번도 성공하지 않았으면 null */
  dbNow: number | null;
  /** DB 시각 - 도구 서버 시각(ms). 30초를 넘으면 경고 */
  clockSkewMs: number | null;
  triggerCounts: Record<string, number> | null;
  nodes: NodeDto[] | null;
  executingCount: number | null;
  /** 마지막 감시가 실패했을 때의 원인. 성공하면 null */
  errorCode: string | null;
  errorMessage: string | null;
  consecutiveFailures: number;
}

/** 시계 차이 경고 기준 (TRD §8.4) */
export const CLOCK_SKEW_WARN_MS = 30_000;

/** `GET /schedulers` 필터 (FR-VIEW-01). 환경은 정확히 일치, 태그는 포함, 검색어는 이름 부분 일치 */
export const dashboardQuerySchema = z.object({
  env: z
    .string()
    .trim()
    .toLowerCase()
    .max(20)
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  tag: z
    .string()
    .trim()
    .max(30)
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  q: z
    .string()
    .trim()
    .max(100)
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/** 스케줄러가 속한 접속의 요약 */
export interface SchedulerConnectionSummary {
  id: number;
  name: string;
  dbType: DbKind;
  envLabel: string;
  tags: string[];
  readOnly: boolean;
  writeCapable: boolean | null;
}

/** 대시보드 카드 하나. 대상 DB를 조회하지 않고 메타 저장소와 스냅샷만 읽는다 (TRD §8.4) */
export interface SchedulerSummaryDto {
  id: number;
  displayName: string;
  schedName: string;
  tablePrefix: string;
  expectedNodeCount: number;
  pollIntervalSec: number;
  connection: SchedulerConnectionSummary;
  /** 아직 한 번도 감시하지 않았으면 null */
  snapshot: SnapshotDto | null;
  openAlertCount: number;
  /** 알림 음소거가 끝나는 시각. 음소거 중이 아니면 null (FR-ALT-10) */
  mutedUntil: number | null;
}

export interface DashboardResponse {
  /** 응답을 만든 도구 서버 시각 */
  generatedAt: number;
  items: SchedulerSummaryDto[];
  /** 필터 선택지. 필터와 상관없이 등록된 전체에서 뽑는다 */
  envs: string[];
  tags: string[];
}
