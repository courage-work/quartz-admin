/** 알림·규칙 심각도 */
export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** 알림 수명주기 (TRD §9.3) */
export const ALERT_STATUSES = ['open', 'acked', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** 알림 규칙 타입 (TRD §9.2) */
export const ALERT_RULE_TYPES = [
  'OVERDUE',
  'TRIGGER_ERROR',
  'BLOCKED_LONG',
  'NODE_MISSING',
  'CLUSTER_DOWN',
  'MONITOR_UNREACHABLE',
] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

/** 알림 채널 (PRD FR-ALT-07) */
export const CHANNEL_TYPES = ['inapp', 'slack', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** 발송 큐 이벤트와 상태 (TRD §9.4) */
export const NOTIFICATION_EVENTS = ['fire', 'update', 'resolve', 'reminder'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** 감사 로그 결과 (TRD §7.1, §10) */
export const AUDIT_RESULTS = ['pending', 'success', 'failure'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** 대시보드 스케줄러 상태: 정상/경고/장애/연결 불가 (PRD FR-VIEW-01) */
export const SCHEDULER_HEALTH = ['ok', 'warning', 'critical', 'unreachable'] as const;
export type SchedulerHealth = (typeof SCHEDULER_HEALTH)[number];
