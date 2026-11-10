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
  'trigger.pause': '트리거 일시정지',
  'trigger.resume': '트리거 재개',
  'job.pause': '잡 일시정지',
  'job.resume': '잡 재개',
  'trigger_group.pause': '트리거 그룹 일시정지',
  'trigger_group.resume': '트리거 그룹 재개',
  'job_group.pause': '잡 그룹 일시정지',
  'job_group.resume': '잡 그룹 재개',
  'job.trigger': '잡 즉시 실행',
  'trigger.reschedule': '트리거 스케줄 수정',
  'trigger.delete': '트리거 삭제',
  'job.delete': '잡 삭제',
};

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? action;
}
