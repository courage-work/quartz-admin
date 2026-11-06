/**
 * 감시 루프와 대시보드 스냅샷 (TRD §8.4, §9.1)
 */
import type { SchedulerHealth } from './domain.js';
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
  /** 가장 오래 밀린 순서로 최대 50개 */
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
