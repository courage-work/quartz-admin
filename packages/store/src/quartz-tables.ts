/** Quartz 2.x JDBC JobStore 테이블(prefix 제외). 자동 감지의 필수·선택 세트 (TRD §5.5) */
export const QUARTZ_REQUIRED_TABLES = [
  'JOB_DETAILS',
  'TRIGGERS',
  'SIMPLE_TRIGGERS',
  'CRON_TRIGGERS',
  'BLOB_TRIGGERS',
  'CALENDARS',
  'PAUSED_TRIGGER_GRPS',
  'FIRED_TRIGGERS',
  'SCHEDULER_STATE',
  'LOCKS',
] as const;

export const QUARTZ_OPTIONAL_TABLES = ['SIMPROP_TRIGGERS'] as const;

export type QuartzRequiredTable = (typeof QUARTZ_REQUIRED_TABLES)[number];
export type QuartzOptionalTable = (typeof QUARTZ_OPTIONAL_TABLES)[number];
export type QuartzTableKey = QuartzRequiredTable | QuartzOptionalTable;

export const QUARTZ_TABLE_KEYS: readonly QuartzTableKey[] = [
  ...QUARTZ_REQUIRED_TABLES,
  ...QUARTZ_OPTIONAL_TABLES,
];

export function isQuartzTableKey(value: string): value is QuartzTableKey {
  return (QUARTZ_TABLE_KEYS as readonly string[]).includes(value);
}
