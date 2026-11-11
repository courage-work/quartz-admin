import { describe, expect, it } from 'vitest';
import type { BindValue, QueryOptions, Row, TargetConn } from '../adapter.js';
import { TargetError } from '../errors.js';
import { oracleDialect } from '../oracle/dialect.js';
import { QUARTZ_REQUIRED_TABLES, type QuartzTableKey } from '../quartz-tables.js';
import { createTableSet } from '../table-set.js';
import { decideBoolFormat } from './bool-format.js';
import { isolationWarning } from './detect.js';
import { checkWritePrivileges } from './privileges.js';
import {
  detectFeatures,
  indexColumns,
  matchTableSets,
  tablesWithoutSchedName,
  type CatalogColumn,
} from './table-sets.js';

const quartzTables = (prefix: string, lower = false, optional = true): string[] =>
  [...QUARTZ_REQUIRED_TABLES, ...(optional ? ['SIMPROP_TRIGGERS'] : [])].map((t) =>
    lower ? `${prefix}${t}`.toLowerCase() : `${prefix}${t}`,
  );

describe('matchTableSets', () => {
  it('기본 prefix 세트를 찾고 하위 트리거 테이블에서 나온 가짜 후보는 버린다', () => {
    const { matched, unusable } = matchTableSets([...quartzTables('QRTZ_'), 'OTHER_TABLE']);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.prefix).toBe('QRTZ_');
    expect(matched[0]!.tableNames.SIMPLE_TRIGGERS).toBe('QRTZ_SIMPLE_TRIGGERS');
    expect(matched[0]!.tableNames.SIMPROP_TRIGGERS).toBe('QRTZ_SIMPROP_TRIGGERS');
    expect(unusable).toEqual([]);
  });

  it('한 스키마의 prefix 여러 개와 사용자 지정 prefix를 각각 찾는다', () => {
    const { matched } = matchTableSets([...quartzTables('QRTZ_'), ...quartzTables('BATCH_QZ_')]);
    expect(matched.map((m) => m.prefix).sort()).toEqual(['BATCH_QZ_', 'QRTZ_']);
  });

  it('prefix가 없는 세트도 찾는다', () => {
    const { matched } = matchTableSets(quartzTables(''));
    expect(matched.map((m) => m.prefix)).toEqual(['']);
  });

  it('대문자 세트와 소문자(따옴표) 세트가 함께 있어도 섞지 않는다', () => {
    const { matched } = matchTableSets([...quartzTables('QRTZ_'), ...quartzTables('qrtz_', true)]);
    const byPrefix = Object.fromEntries(matched.map((m) => [m.prefix, m.tableNames]));
    expect(byPrefix.QRTZ_?.LOCKS).toBe('QRTZ_LOCKS');
    expect(byPrefix.qrtz_?.LOCKS).toBe('qrtz_locks');
  });

  it('필수 테이블이 빠진 세트는 이유와 함께 따로 돌려준다', () => {
    const tables = quartzTables('QRTZ_').filter(
      (t) => t !== 'QRTZ_LOCKS' && t !== 'QRTZ_CALENDARS',
    );
    const { matched, unusable } = matchTableSets(tables);
    expect(matched).toEqual([]);
    expect(unusable).toEqual([
      { prefix: 'QRTZ_', reason: 'MISSING_TABLES', tables: ['CALENDARS', 'LOCKS'] },
    ]);
  });

  it('SIMPROP_TRIGGERS가 없어도 세트로 인정한다(선택 테이블)', () => {
    const { matched } = matchTableSets(quartzTables('QRTZ_', false, false));
    expect(matched).toHaveLength(1);
    expect(matched[0]!.tableNames.SIMPROP_TRIGGERS).toBeUndefined();
  });
});

function columnsFor(
  prefix: string,
  extra: Partial<Record<QuartzTableKey, string[]>> = {},
): CatalogColumn[] {
  const base: Partial<Record<QuartzTableKey, string[]>> = {
    JOB_DETAILS: ['SCHED_NAME', 'JOB_NAME', 'IS_DURABLE', 'IS_NONCONCURRENT', 'IS_UPDATE_DATA'],
    TRIGGERS: ['SCHED_NAME', 'TRIGGER_NAME', 'PRIORITY'],
    FIRED_TRIGGERS: ['SCHED_NAME', 'ENTRY_ID', 'PRIORITY', 'SCHED_TIME'],
    CRON_TRIGGERS: ['SCHED_NAME', 'CRON_EXPRESSION', 'TIME_ZONE_ID'],
    SCHEDULER_STATE: ['SCHED_NAME', 'INSTANCE_NAME'],
    LOCKS: ['SCHED_NAME', 'LOCK_NAME'],
  };
  const merged = { ...base, ...extra };
  return Object.entries(merged).flatMap(([table, cols]) =>
    cols.map((column) => ({ table: `${prefix}${table}`, column, dataType: 'VARCHAR2' })),
  );
}

describe('detectFeatures', () => {
  it('2.2 이상 스키마는 선택 컬럼이 모두 있다', () => {
    const { matched } = matchTableSets(quartzTables('QRTZ_'));
    const features = detectFeatures(matched[0]!, indexColumns(columnsFor('QRTZ_')));
    expect(features).toEqual({
      simpropTriggers: true,
      triggerPriority: true,
      firedPriority: true,
      firedSchedTime: true,
      jobNonconcurrent: true,
      jobUpdateData: true,
      cronTimeZone: true,
    });
  });

  it('없는 테이블과 컬럼은 false (2.0~2.1 스키마)', () => {
    const { matched } = matchTableSets(quartzTables('QRTZ_', false, false));
    const features = detectFeatures(
      matched[0]!,
      indexColumns(columnsFor('QRTZ_', { FIRED_TRIGGERS: ['SCHED_NAME', 'ENTRY_ID', 'PRIORITY'] })),
    );
    expect(features.simpropTriggers).toBe(false);
    expect(features.firedSchedTime).toBe(false);
    expect(features.firedPriority).toBe(true);
  });

  it('SCHED_NAME 컬럼이 없는 테이블(Quartz 1.x)을 찾는다', () => {
    const { matched } = matchTableSets(quartzTables('QRTZ_'));
    const columns = indexColumns(columnsFor('QRTZ_', { LOCKS: ['LOCK_NAME'] }));
    expect(tablesWithoutSchedName(matched[0]!, columns)).toEqual(['LOCKS']);
  });
});

describe('decideBoolFormat', () => {
  it('BOOLEAN 컬럼은 값과 상관없이 native', () => {
    expect(decideBoolFormat('BOOLEAN', [])).toMatchObject({
      format: 'native',
      source: 'column-type',
    });
    expect(decideBoolFormat('bool', ['1'])).toMatchObject({ format: 'native' });
  });

  it.each([
    [['1', '0'], '10'],
    [['Y', 'N'], 'YN'],
    [['n'], 'YN'],
    [['T', 'F'], 'TF'],
    [['true', 'false'], 'TF'],
    [[1, 0], '10'],
    [['1 '], '10'],
  ])('문자·숫자 값 %j → %s', (values, format) => {
    expect(decideBoolFormat('VARCHAR2', values)).toEqual({
      format,
      source: 'values',
      warnings: [],
    });
  });

  it('값이 없으면 Quartz 기본값 10', () => {
    expect(decideBoolFormat('VARCHAR2', [])).toEqual({
      format: '10',
      source: 'default',
      warnings: [],
    });
    expect(decideBoolFormat('VARCHAR2', [null])).toMatchObject({ format: '10', source: 'default' });
  });

  it('형식이 섞이거나 모르는 값이 있으면 경고를 붙인다', () => {
    expect(decideBoolFormat('VARCHAR2', ['1', '0', 'Y'])).toEqual({
      format: '10',
      source: 'values',
      warnings: ['BOOL_FORMAT_MIXED'],
    });
    expect(decideBoolFormat('VARCHAR2', ['X', 'Y', 'N'])).toEqual({
      format: 'YN',
      source: 'values',
      warnings: ['BOOL_FORMAT_UNKNOWN_VALUE'],
    });
  });
});

/** 실행한 SQL을 기록하고, 정한 문장만 권한 오류로 실패시키는 커넥션 */
class RecordingConn implements TargetConn {
  readonly kind = 'oracle' as const;
  readonly log: string[] = [];
  inTransaction = false;
  constructor(private readonly deny: (sql: string) => boolean) {}
  private run(sql: string): void {
    this.log.push(sql);
    if (this.deny(sql)) {
      throw new TargetError('TARGET_ERROR', { driverCode: 'ORA-01031' });
    }
  }
  query<R extends Row = Row>(
    sql: string,
    _b?: readonly BindValue[],
    _o?: QueryOptions,
  ): Promise<R[]> {
    this.run(sql);
    return Promise.resolve([]);
  }
  execute(sql: string): Promise<number> {
    this.run(sql);
    this.inTransaction = true;
    return Promise.resolve(0);
  }
  commit(): Promise<void> {
    throw new Error('권한 점검은 커밋하면 안 된다');
  }
  rollback(): Promise<void> {
    this.log.push('ROLLBACK');
    this.inTransaction = false;
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('checkWritePrivileges', () => {
  const tables = createTableSet(oracleDialect, {
    schema: 'Q',
    tables: Object.fromEntries(QUARTZ_REQUIRED_TABLES.map((t) => [t, `QRTZ_${t}`])),
  });

  it('결과 0행 문장만 실행하고 마지막에 ROLLBACK한다', async () => {
    const conn = new RecordingConn(() => false);
    expect(await checkWritePrivileges(conn, tables)).toEqual([]);
    const statements = conn.log.filter((s) => s !== 'ROLLBACK');
    expect(statements.length).toBeGreaterThan(20);
    for (const sql of statements) expect(sql).toMatch(/WHERE 1 = 0$/);
    expect(conn.log.at(-1)).toBe('ROLLBACK');
    expect(conn.log.some((s) => s.includes('SIMPROP'))).toBe(false); // 없는 선택 테이블은 건너뛴다
  });

  it('권한 오류가 난 문장을 모으고 그때마다 ROLLBACK한다', async () => {
    const conn = new RecordingConn((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql));
    const missing = await checkWritePrivileges(conn, tables);
    expect(missing).toContainEqual({
      table: 'TRIGGERS',
      privilege: 'UPDATE',
      driverCode: 'ORA-01031',
    });
    expect(missing).toContainEqual({
      table: 'LOCKS',
      privilege: 'INSERT',
      driverCode: 'ORA-01031',
    });
    expect(missing.some((m) => m.privilege === 'SELECT')).toBe(false);
    const firstFail = conn.log.findIndex((s) => s.startsWith('INSERT'));
    expect(conn.log[firstFail + 1]).toBe('ROLLBACK');
  });

  it('연결 오류는 판정하지 않고 던지되 ROLLBACK은 시도한다', async () => {
    const conn = new RecordingConn(() => false);
    conn.query = () => Promise.reject(new TargetError('TARGET_UNREACHABLE'));
    await expect(checkWritePrivileges(conn, tables)).rejects.toMatchObject({
      code: 'TARGET_UNREACHABLE',
    });
    expect(conn.log.at(-1)).toBe('ROLLBACK');
  });
});

describe('isolationWarning (서버 기본 격리 수준)', () => {
  it('REPEATABLE READ면 misfire 경합 경고, 그 밖은 없음', () => {
    expect(isolationWarning('REPEATABLE-READ')).toBe('REPEATABLE_READ_MISFIRE_RACE');
    expect(isolationWarning('repeatable read')).toBe('REPEATABLE_READ_MISFIRE_RACE');
    expect(isolationWarning('READ-COMMITTED')).toBeNull();
    expect(isolationWarning('SERIALIZABLE')).toBeNull();
    expect(isolationWarning(null)).toBeNull();
  });
});
