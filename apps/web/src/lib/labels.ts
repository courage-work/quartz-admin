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
};

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? action;
}
