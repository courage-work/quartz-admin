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

/**
 * 톤별 정적 클래스. 화면에서 `bg-${tone}`처럼 만들지 않도록 여기에 모아 둔다(require-static-classes).
 * - rail: 카드 위 상태 띠, 점
 * - fill: SVG 막대 조각
 * - soft: 아이콘 바탕·강조 영역(-subtle 쌍)
 * - text: 글자 없이 쓰는 작은 아이콘(대비 3:1 기준)
 */
export const TONE_CLASSES = {
  success: {
    rail: 'bg-success',
    fill: 'fill-success',
    soft: 'bg-success-subtle text-success-subtle-foreground',
    text: 'text-success',
  },
  warning: {
    rail: 'bg-warning',
    fill: 'fill-warning',
    soft: 'bg-warning-subtle text-warning-subtle-foreground',
    text: 'text-warning',
  },
  info: {
    rail: 'bg-info',
    fill: 'fill-info',
    soft: 'bg-info-subtle text-info-subtle-foreground',
    text: 'text-info',
  },
  destructive: {
    rail: 'bg-destructive',
    fill: 'fill-destructive',
    soft: 'bg-destructive-subtle text-destructive-subtle-foreground',
    text: 'text-destructive',
  },
  neutral: {
    rail: 'bg-muted-foreground',
    fill: 'fill-muted-foreground',
    soft: 'bg-muted text-muted-foreground',
    text: 'text-muted-foreground',
  },
} as const satisfies Record<Tone, { rail: string; fill: string; soft: string; text: string }>;

/** 대시보드 정렬 순서: 손봐야 할 것을 먼저 보여 준다. 감시 전(null)은 맨 뒤 */
export const HEALTH_ORDER: Record<SchedulerHealth, number> = {
  critical: 0,
  unreachable: 1,
  warning: 2,
  ok: 3,
};
