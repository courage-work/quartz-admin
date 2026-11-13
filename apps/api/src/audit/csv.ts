import type { AuditLogDto } from '@qa/shared';

/**
 * 감사 로그 CSV (FR-AUD-05, TRD §10). RFC 4180 형식이고 줄바꿈은 CRLF다.
 * Excel에서 한글이 깨지지 않도록 파일 맨 앞에 BOM을 붙인다(`AUDIT_CSV_PREAMBLE`).
 */

type Cell = string | number | null;

const COLUMNS: { header: string; value: (log: AuditLogDto) => Cell }[] = [
  { header: 'id', value: (l) => l.id },
  // 화면 시간대와 관계없이 같은 값이 되도록 UTC ISO 8601로 쓴다
  { header: '시각(UTC)', value: (l) => new Date(l.at).toISOString() },
  { header: '사용자', value: (l) => l.username },
  { header: 'IP', value: (l) => l.ip },
  { header: '요청 ID', value: (l) => l.requestId },
  { header: '작업', value: (l) => l.action },
  { header: '대상 종류', value: (l) => l.targetType },
  { header: '대상', value: (l) => json(l.target) },
  { header: '접속 ID', value: (l) => l.connectionId },
  { header: '스케줄러 ID', value: (l) => l.schedulerId },
  { header: '결과', value: (l) => l.result },
  { header: '오류 코드', value: (l) => l.errorCode },
  { header: '오류 메시지', value: (l) => l.errorMessage },
  { header: '사유', value: (l) => l.reason },
  { header: '변경 전', value: (l) => json(l.before) },
  { header: '변경 후', value: (l) => json(l.after) },
];

const json = (value: unknown) =>
  value === null || value === undefined ? null : JSON.stringify(value);

/**
 * 칸 하나. 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 따옴표는 두 번 쓴다. 사용자가 넣은 값(아이디, 대상 이름)이
 * 스프레드시트에서 수식으로 실행되지 않도록 `=`, `+`, `-`, `@`, 탭, CR로 시작하는 글은 앞에 `'`를 붙인다
 * (OWASP CSV Injection). 숫자는 그대로 둔다.
 */
export function csvField(value: Cell): string {
  if (value === null) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 바이트 순서 표시. Excel이 UTF-8로 읽게 한다 */
const BOM = String.fromCharCode(0xfeff);

const line = (cells: Cell[]) => `${cells.map(csvField).join(',')}\r\n`;

/** BOM과 머리글 줄 */
export const AUDIT_CSV_PREAMBLE = `${BOM}${line(COLUMNS.map((c) => c.header))}`;

/** 기록 하나의 줄 */
export function auditCsvRow(log: AuditLogDto): string {
  return line(COLUMNS.map((c) => c.value(log)));
}

/** 내려받는 파일 이름. `audit-logs-20261113-063512.csv`(UTC) */
export function auditCsvFilename(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `audit-logs-${stamp}.csv`;
}
