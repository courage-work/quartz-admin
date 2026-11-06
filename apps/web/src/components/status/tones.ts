import type { AuditResult, SchedulerHealth, Severity, TriggerState } from '@qa/shared';
import {
  BanIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  ClockIcon,
  InfoIcon,
  LoaderIcon,
  type LucideIcon,
  OctagonAlertIcon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UnplugIcon,
} from 'lucide-react';

/**
 * 상태 톤. 색만으로 구분하지 않도록 톤마다 아이콘과 한국어 라벨을 함께 쓴다.
 * Badge variant 이름과 같다(components/ui/badge.tsx).
 */
export type Tone = 'success' | 'warning' | 'info' | 'destructive' | 'neutral';

export interface StatusMeta {
  tone: Tone;
  label: string;
  icon: LucideIcon;
}

/** QRTZ_TRIGGERS.TRIGGER_STATE (`@qa/shared` TRIGGER_STATES) */
export const TRIGGER_STATE_META = {
  WAITING: { tone: 'success', label: '대기', icon: ClockIcon },
  ACQUIRED: { tone: 'info', label: '획득', icon: CircleDotIcon },
  EXECUTING: { tone: 'info', label: '실행 중', icon: PlayIcon },
  COMPLETE: { tone: 'neutral', label: '완료', icon: CircleCheckIcon },
  BLOCKED: { tone: 'warning', label: '차단', icon: BanIcon },
  ERROR: { tone: 'destructive', label: '오류', icon: CircleXIcon },
  PAUSED: { tone: 'neutral', label: '일시정지', icon: PauseIcon },
  PAUSED_BLOCKED: { tone: 'warning', label: '일시정지(차단)', icon: PauseIcon },
  DELETED: { tone: 'neutral', label: '삭제됨', icon: Trash2Icon },
} as const satisfies Record<TriggerState, StatusMeta>;

export type { TriggerState };

/** 대시보드 스케줄러 상태 (PRD FR-VIEW-01) */
export const SCHEDULER_HEALTH_META = {
  ok: { tone: 'success', label: '정상', icon: CircleCheckIcon },
  warning: { tone: 'warning', label: '경고', icon: TriangleAlertIcon },
  critical: { tone: 'destructive', label: '장애', icon: OctagonAlertIcon },
  unreachable: { tone: 'neutral', label: '연결 불가', icon: UnplugIcon },
} as const satisfies Record<SchedulerHealth, StatusMeta>;

/** 알림 심각도 */
export const SEVERITY_META = {
  info: { tone: 'info', label: '정보', icon: InfoIcon },
  warning: { tone: 'warning', label: '경고', icon: TriangleAlertIcon },
  critical: { tone: 'destructive', label: '심각', icon: OctagonAlertIcon },
} as const satisfies Record<Severity, StatusMeta>;

/** 감사 로그 결과 (TRD §10) */
export const AUDIT_RESULT_META = {
  success: { tone: 'success', label: '성공', icon: CircleCheckIcon },
  failure: { tone: 'destructive', label: '실패', icon: CircleXIcon },
  pending: { tone: 'info', label: '진행 중', icon: LoaderIcon },
} as const satisfies Record<AuditResult, StatusMeta>;
