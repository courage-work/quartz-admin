import type { AuditResult, SchedulerHealth, Severity } from '@qa/shared';

import { Badge } from '@/components/ui/badge';

import {
  AUDIT_RESULT_META,
  SCHEDULER_HEALTH_META,
  SEVERITY_META,
  type StatusMeta,
  TRIGGER_STATE_META,
} from './tones';

/** 톤 + 아이콘 + 라벨. 원래 값(예: `PAUSED_BLOCKED`)은 title로 보여 준다. */
export function StatusBadge({ meta, code }: { meta: StatusMeta; code?: string }) {
  const Icon = meta.icon;
  return (
    <Badge variant={meta.tone} title={code}>
      <Icon data-icon="inline-start" aria-hidden />
      {meta.label}
    </Badge>
  );
}

/** 모르는 상태 값(사용자 정의 등)은 원래 값을 회색 배지로 보여 준다 */
export function TriggerStateBadge({ state }: { state: string }) {
  const meta = (TRIGGER_STATE_META as Record<string, StatusMeta>)[state];
  if (!meta) return <Badge variant="neutral">{state}</Badge>;
  return <StatusBadge meta={meta} code={state} />;
}

export function SchedulerHealthBadge({ health }: { health: SchedulerHealth }) {
  return <StatusBadge meta={SCHEDULER_HEALTH_META[health]} />;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <StatusBadge meta={SEVERITY_META[severity]} />;
}

export function AuditResultBadge({ result }: { result: AuditResult }) {
  return <StatusBadge meta={AUDIT_RESULT_META[result]} code={result} />;
}
