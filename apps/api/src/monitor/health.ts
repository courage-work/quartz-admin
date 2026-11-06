import { CLOCK_SKEW_WARN_MS, type MonitorData, type SchedulerHealth } from '@qa/shared';

/**
 * 감시 결과로 대시보드 상태를 정한다 (PRD FR-VIEW-01, TRD §8.4). 알림 규칙(§9.2)의 기본 조건과 같은 기준이다.
 * 알림 엔진(B-24)이 붙으면 열린 알림의 심각도와 함께 다시 정할 수 있다.
 *
 * - critical: 활성 노드 0개(CLUSTER_DOWN) 또는 ERROR 트리거가 있음(TRIGGER_ERROR)
 * - warning: 활성 노드가 기대 노드 수보다 적음(NODE_MISSING), 연체 트리거가 있음(OVERDUE), 시계 차이 30초 초과
 * - ok: 그 밖
 * 연결하지 못한 경우(unreachable)는 감시 실패 쪽에서 정한다.
 */
export function deriveHealth(
  data: Pick<MonitorData, 'nodes' | 'overdueCount' | 'triggerCounts'>,
  settings: { expectedNodeCount: number },
  clockSkewMs: number,
): SchedulerHealth {
  const active = data.nodes.filter((n) => n.active).length;
  if (active === 0 || (data.triggerCounts.ERROR ?? 0) > 0) return 'critical';
  if (
    active < settings.expectedNodeCount ||
    data.overdueCount > 0 ||
    Math.abs(clockSkewMs) > CLOCK_SKEW_WARN_MS
  ) {
    return 'warning';
  }
  return 'ok';
}
