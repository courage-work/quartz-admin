import type { AuditLogDto, AuditLogQuery } from '@qa/shared';

import type { Query } from '@/lib/api';
import { dateRange } from '@/lib/format';

/** 감사 로그 목록 필터. 화면 입력 그대로의 값이다 */
export interface AuditFilter {
  fromDate: string;
  toDate: string;
  action: string;
  result: string;
  username: string;
}

export const EMPTY_AUDIT_FILTER: AuditFilter = {
  fromDate: '',
  toDate: '',
  action: 'all',
  result: 'all',
  username: '',
};

/** 화면 필터 → `GET /audit-logs` 쿼리. 비어 있는 값은 빼고, 날짜는 사용자 타임존의 하루 경계로 바꾼다 */
export function auditQuery(filter: AuditFilter): Query & Partial<AuditLogQuery> {
  const username = filter.username.trim().toLowerCase();
  return {
    ...dateRange(filter.fromDate, filter.toDate),
    ...(filter.action !== 'all' ? { action: filter.action as AuditLogQuery['action'] } : {}),
    ...(filter.result !== 'all' ? { result: filter.result as AuditLogQuery['result'] } : {}),
    ...(username ? { username } : {}),
  };
}

function field(target: unknown, key: string): unknown {
  return typeof target === 'object' && target !== null
    ? (target as Record<string, unknown>)[key]
    : undefined;
}

/** 목록에 보여 줄 대상 요약. 사용자는 아이디, 없으면 `#id` */
export function describeTarget(log: Pick<AuditLogDto, 'targetType' | 'target'>): string {
  if (log.targetType === 'user') {
    const username = field(log.target, 'username');
    const id = field(log.target, 'id');
    if (typeof username === 'string') return username;
    if (typeof id === 'number') return `#${id}`;
  }
  return '-';
}

/** 사용자를 시스템 작업과 구분해 보여 준다 */
export function describeActor(log: Pick<AuditLogDto, 'username' | 'userId'>): string {
  if (log.username) return log.username;
  return log.userId === null ? '시스템' : `#${log.userId}`;
}
