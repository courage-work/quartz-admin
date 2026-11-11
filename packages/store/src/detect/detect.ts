import type { Row, TargetConn } from '../adapter.js';
import { queryDbNowMillis, type QuartzDialect } from '../dialect.js';
import { TargetError } from '../errors.js';
import { readString } from '../normalize.js';
import { createTableSet, type TableSet } from '../table-set.js';
import { decideBoolFormat, type BoolFormatResult } from './bool-format.js';
import { checkWritePrivileges } from './privileges.js';
import {
  columnType,
  detectFeatures,
  indexColumns,
  matchTableSets,
  tablesWithoutSchedName,
  type CatalogColumn,
  type ColumnIndex,
  type MatchedTableSet,
} from './table-sets.js';
import type {
  DetectedTableSet,
  DetectionWarning,
  QuartzDetection,
  QuartzFeatures,
  SchedulerCandidate,
  UnusableTableSet,
} from './types.js';

export interface DetectOptions {
  /** 테이블 소유 스키마. 비우면 접속 계정의 현재 스키마 */
  schema?: string | undefined;
  /** 활성 노드 판정 배수. 기본 3 (`schedulers.checkin_multiplier` 기본값) */
  checkinMultiplier?: number;
}

const BOOL_COLUMNS = ['IS_DURABLE', 'IS_NONCONCURRENT', 'IS_UPDATE_DATA', 'REQUESTS_RECOVERY'];

/**
 * Quartz 스키마 자동 감지 (TRD §5.5, FR-CON-03, FR-CON-04).
 *
 * 카탈로그로 테이블 세트와 prefix, 선택 컬럼, 불리언 형식을 찾고, SCHED_NAME 후보와 노드 수를 세며,
 * 쓰기 권한을 점검한다. 조회와 결과 0행 쓰기만 하고 ROLLBACK하므로 대상 행을 잠그거나 바꾸지 않는다.
 */
export async function detectQuartz(
  conn: TargetConn,
  dialect: QuartzDialect,
  options: DetectOptions = {},
): Promise<QuartzDetection> {
  const schema = await resolveSchema(conn, dialect, options.schema);
  const tableRows = await conn.query(dialect.catalog.tables, [schema]);
  const tableNames = tableRows.map((r) => requireString(r, 'TABLE_NAME'));
  const { matched, unusable } = matchTableSets(tableNames);

  const columnRows =
    matched.length === 0 ? [] : await conn.query(dialect.catalog.columns, [schema]);
  const columns = indexColumns(
    columnRows.map((r): CatalogColumn => ({
      table: requireString(r, 'TABLE_NAME'),
      column: requireString(r, 'COLUMN_NAME'),
      dataType: requireString(r, 'DATA_TYPE'),
    })),
  );

  const dbNow = await queryDbNowMillis(conn, dialect);
  const serverWarnings = await serverIsolationWarnings(conn, dialect);
  const multiplier = options.checkinMultiplier ?? 3;
  const tableSets: DetectedTableSet[] = [];
  const allUnusable: UnusableTableSet[] = [...unusable];

  for (const set of matched) {
    const withoutSchedName = tablesWithoutSchedName(set, columns);
    if (withoutSchedName.length > 0) {
      allUnusable.push({ prefix: set.prefix, reason: 'NO_SCHED_NAME', tables: withoutSchedName });
      continue;
    }
    const inspected = await inspectTableSet(conn, dialect, schema, set, columns, dbNow, multiplier);
    tableSets.push({ ...inspected, warnings: [...inspected.warnings, ...serverWarnings] });
  }

  return { schema, dbNow, tableSets, unusable: allUnusable };
}

/**
 * 서버 기본 격리 수준으로 판단한 경고. REPEATABLE READ면 Quartz 노드의 misfire 처리(`doRecoverMisfires`)가
 * 잠금을 잡기 전에 연 스냅샷으로, 도구나 다른 노드가 잠금 안에서 바꾼 일시정지를 덮어쓸 수 있다 (TRD §5.3)
 */
export function isolationWarning(value: unknown): DetectionWarning | null {
  const level = readString(value)
    ?.trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-');
  return level === 'REPEATABLE-READ' ? 'REPEATABLE_READ_MISFIRE_RACE' : null;
}

async function serverIsolationWarnings(
  conn: TargetConn,
  dialect: QuartzDialect,
): Promise<DetectionWarning[]> {
  const sql = dialect.catalog.serverIsolation;
  if (sql === undefined) return [];
  let rows: Row[];
  try {
    rows = await conn.query(sql);
  } catch (err) {
    // 변수가 없는 오래된 서버. 연결·시간 문제는 감지 전체를 실패시킨다
    if (err instanceof TargetError && err.code === 'TARGET_ERROR') return [];
    throw err;
  }
  const warning = isolationWarning(rows[0]?.ISOLATION);
  return warning === null ? [] : [warning];
}

async function resolveSchema(
  conn: TargetConn,
  dialect: QuartzDialect,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined && requested.trim() !== '') {
    const name = requested.trim();
    // Oracle은 따옴표 없이 만든 계정 이름이 대문자다. 입력한 그대로 없으면 대문자로 한 번 더 찾는다
    if (name !== name.toUpperCase()) {
      const exact = await conn.query(dialect.catalog.tables, [name]);
      if (exact.length === 0) return name.toUpperCase();
    }
    return name;
  }
  const rows = await conn.query(dialect.catalog.currentSchema);
  const current = rows[0] === undefined ? null : readString(rows[0].SCHEMA_NAME);
  if (current === null) {
    throw new TargetError('TARGET_ERROR', { detail: '현재 스키마를 확인하지 못했습니다' });
  }
  return current;
}

async function inspectTableSet(
  conn: TargetConn,
  dialect: QuartzDialect,
  schema: string,
  set: MatchedTableSet,
  columns: ColumnIndex,
  dbNow: number,
  multiplier: number,
): Promise<DetectedTableSet> {
  const tables = createTableSet(dialect, { schema, tables: set.tableNames });
  const features = detectFeatures(set, columns);
  const bool = await detectBoolFormat(conn, dialect, tables, set, columns, features);
  const schedulers = await schedulerCandidates(conn, dialect, tables, dbNow, multiplier);
  const missingPrivileges = await checkWritePrivileges(conn, tables);
  return {
    prefix: set.prefix,
    tableNames: { ...set.tableNames },
    features,
    boolFormat: bool.format,
    boolFormatSource: bool.source,
    writeCapable: missingPrivileges.length === 0,
    missingPrivileges,
    schedulers,
    warnings: bool.warnings,
  };
}

async function detectBoolFormat(
  conn: TargetConn,
  dialect: QuartzDialect,
  tables: TableSet,
  set: MatchedTableSet,
  columns: ColumnIndex,
  features: QuartzFeatures,
): Promise<BoolFormatResult> {
  const type = columnType(set, columns, 'JOB_DETAILS', 'IS_DURABLE');
  const native = decideBoolFormat(type, []);
  if (native.format === 'native') return native;

  const present = BOOL_COLUMNS.filter(
    (c) =>
      columnType(set, columns, 'JOB_DETAILS', c) !== undefined &&
      (c !== 'IS_NONCONCURRENT' || features.jobNonconcurrent) &&
      (c !== 'IS_UPDATE_DATA' || features.jobUpdateData),
  );
  if (present.length === 0) return decideBoolFormat(type, []);
  const job = tables.table('JOB_DETAILS');
  const v = dialect.quote('V');
  const sql = present.map((c) => `SELECT DISTINCT ${c} AS ${v} FROM ${job}`).join(' UNION ');
  const rows = await conn.query(sql);
  return decideBoolFormat(
    type,
    rows.map((r) => r.V),
  );
}

async function schedulerCandidates(
  conn: TargetConn,
  dialect: QuartzDialect,
  tables: TableSet,
  dbNow: number,
  multiplier: number,
): Promise<SchedulerCandidate[]> {
  const q = (alias: string) => dialect.quote(alias);
  const names = await conn.query(
    (['TRIGGERS', 'JOB_DETAILS', 'SCHEDULER_STATE', 'LOCKS'] as const)
      .map((key) => `SELECT SCHED_NAME AS ${q('SCHED_NAME')} FROM ${tables.table(key)}`)
      .join(' UNION '),
  );
  const countBy = async (key: 'JOB_DETAILS' | 'TRIGGERS'): Promise<Map<string, number>> => {
    const rows = await conn.query(
      `SELECT SCHED_NAME AS ${q('SCHED_NAME')}, COUNT(*) AS ${q('CNT')} ` +
        `FROM ${tables.table(key)} GROUP BY SCHED_NAME`,
    );
    return new Map(rows.map((r) => [requireString(r, 'SCHED_NAME'), dialect.readLong(r.CNT) ?? 0]));
  };
  const jobs = await countBy('JOB_DETAILS');
  const triggers = await countBy('TRIGGERS');
  const nodes = await conn.query(
    `SELECT SCHED_NAME AS ${q('SCHED_NAME')}, LAST_CHECKIN_TIME AS ${q('LAST_CHECKIN_TIME')}, ` +
      `CHECKIN_INTERVAL AS ${q('CHECKIN_INTERVAL')} FROM ${tables.table('SCHEDULER_STATE')}`,
  );

  return names
    .map((r) => requireString(r, 'SCHED_NAME'))
    .sort()
    .map((schedName) => {
      const own = nodes.filter((n) => n.SCHED_NAME === schedName);
      // TRD §9.2: LAST_CHECKIN_TIME + CHECKIN_INTERVAL × checkin_multiplier ≥ dbNow
      const active = own.filter((n) => {
        const last = dialect.readLong(n.LAST_CHECKIN_TIME) ?? 0;
        const interval = dialect.readLong(n.CHECKIN_INTERVAL) ?? 0;
        return last + interval * multiplier >= dbNow;
      }).length;
      return {
        schedName,
        jobCount: jobs.get(schedName) ?? 0,
        triggerCount: triggers.get(schedName) ?? 0,
        nodeCount: own.length,
        activeNodeCount: active,
        expectedNodeCount: active,
      };
    });
}

function requireString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new TargetError('TARGET_ERROR', { detail: `카탈로그 결과에 ${key} 값이 없습니다` });
  }
  return value;
}
