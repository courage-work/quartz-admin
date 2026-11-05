/** 지원 대상 DB 종류 (TRD §5.1) */
export const DB_KINDS = ['oracle', 'postgresql', 'mysql', 'mariadb'] as const;

export type DbKind = (typeof DB_KINDS)[number];

export function isDbKind(value: unknown): value is DbKind {
  return typeof value === 'string' && (DB_KINDS as readonly string[]).includes(value);
}
