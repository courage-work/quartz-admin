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

/** 빠른 기간: 오늘을 끝으로 하는 최근 `days`일(오늘 포함). 사용자 타임존의 날짜(`YYYY-MM-DD`)로 돌려준다 */
export function recentDays(
  days: number,
  now: Date = new Date(),
): Pick<AuditFilter, 'fromDate' | 'toDate'> {
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { fromDate: ymd(from), toDate: ymd(now) };
}

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

/** 목록에 보여 줄 대상 요약. 사용자는 아이디, 접속은 이름, 스케줄러는 표시 이름이나 SCHED_NAME, 없으면 `#id` */
export function describeTarget(log: Pick<AuditLogDto, 'targetType' | 'target'>): string {
  const nameKey: Record<string, string[]> = {
    user: ['username'],
    connection: ['name'],
    scheduler: ['displayName', 'schedName'],
  };
  // 제어 명령은 SCHED_NAME과 대상 키(트리거·잡은 그룹과 이름, 그룹은 이름)를 남긴다
  if (log.targetType === 'trigger' || log.targetType === 'job') {
    const key = field(log.target, log.targetType);
    const group = field(key, 'group');
    const name = field(key, 'name');
    if (typeof group === 'string' && typeof name === 'string') return `${group} / ${name}`;
  }
  if (log.targetType === 'trigger_group' || log.targetType === 'job_group') {
    const group = field(log.target, 'group');
    if (typeof group === 'string') return group;
  }
  const keys = log.targetType ? nameKey[log.targetType] : undefined;
  if (!keys) return '-';
  for (const key of keys) {
    const value = field(log.target, key);
    if (typeof value === 'string') return value;
  }
  // 스케줄러 등록은 여러 개를 한 번에 기록한다. 실패한 등록은 고른 후보(selections)만 남는다
  for (const listKey of ['schedulers', 'selections']) {
    const list = field(log.target, listKey);
    if (Array.isArray(list) && list.length > 0) {
      return list
        .map((s) => field(s, 'displayName') ?? field(s, 'schedName'))
        .filter((v): v is string => typeof v === 'string')
        .join(', ');
    }
  }
  const id = field(log.target, 'id');
  return typeof id === 'number' ? `#${id}` : '-';
}

/**
 * 대상이 식별자(사용자 아이디, 트리거·잡 키, 그룹 이름)인지. 식별자는 고정폭으로, 사람이 붙인 이름(접속, 스케줄러)은
 * 다른 목록처럼 본문 글꼴로 보인다
 */
const CODE_TARGETS: ReadonlySet<string> = new Set([
  'user',
  'trigger',
  'job',
  'trigger_group',
  'job_group',
]);

export function isCodeTarget(log: Pick<AuditLogDto, 'targetType'>): boolean {
  return log.targetType !== null && CODE_TARGETS.has(log.targetType);
}

/** 사용자를 시스템 작업과 구분해 보여 준다 */
export function describeActor(log: Pick<AuditLogDto, 'username' | 'userId'>): string {
  if (log.username) return log.username;
  return log.userId === null ? '시스템' : `#${log.userId}`;
}
