import type { AuditAction } from '@qa/shared';

/** 감사 로그 작업 종류 라벨. `AUDIT_ACTIONS`에 항목이 늘면 타입 오류로 알려 준다 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'auth.login': '로그인',
  'auth.logout': '로그아웃',
  'auth.password_change': '비밀번호 변경',
  'user.create': '사용자 추가',
  'user.activate': '사용자 활성화',
  'user.deactivate': '사용자 비활성화',
  'user.password_reset': '비밀번호 초기화',
  'connection.create': '접속 추가',
  'connection.update': '접속 수정',
  'connection.delete': '접속 삭제',
  'connection.detect': '스케줄러 감지',
  'scheduler.register': '스케줄러 등록',
  'scheduler.update': '스케줄러 설정 변경',
  'scheduler.delete': '스케줄러 등록 해제',
  'scheduler.mute': '알림 음소거',
  'scheduler.unmute': '알림 음소거 해제',
  'trigger.pause': '트리거 일시정지',
  'trigger.resume': '트리거 재개',
  'job.pause': '잡 일시정지',
  'job.resume': '잡 재개',
  'trigger_group.pause': '트리거 그룹 일시정지',
  'trigger_group.resume': '트리거 그룹 재개',
  'job_group.pause': '잡 그룹 일시정지',
  'job_group.resume': '잡 그룹 재개',
  'scheduler.pause': '스케줄러 전체 일시정지',
  'scheduler.resume': '스케줄러 전체 재개',
  'job.trigger': '잡 즉시 실행',
  'trigger.reschedule': '트리거 스케줄 수정',
  'trigger.delete': '트리거 삭제',
  'job.delete': '잡 삭제',
  'alert_rule.create': '알림 규칙 추가',
  'alert_rule.update': '알림 규칙 수정',
  'alert_rule.delete': '알림 규칙 삭제',
  'channel.create': '알림 채널 추가',
  'channel.update': '알림 채널 수정',
  'channel.delete': '알림 채널 삭제',
  'channel.test': '알림 채널 테스트 발송',
  'alert.ack': '알림 확인',
};

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? action;
}
