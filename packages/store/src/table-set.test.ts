import { describe, expect, it } from 'vitest';
import { oracleDialect } from './oracle/dialect.js';
import { QUARTZ_REQUIRED_TABLES, type QuartzTableKey } from './quartz-tables.js';
import { createTableSet } from './table-set.js';

function names(prefix: string, lower = false): Partial<Record<QuartzTableKey, string>> {
  return Object.fromEntries(
    QUARTZ_REQUIRED_TABLES.map((t) => {
      const name = `${prefix}${t}`;
      return [t, lower ? name.toLowerCase() : name];
    }),
  );
}

describe('createTableSet', () => {
  it('스키마를 붙이고 감지한 실제 이름을 따옴표로 감싼다', () => {
    const set = createTableSet(oracleDialect, { schema: 'QUARTZ', tables: names('QRTZ_') });
    expect(set.table('TRIGGERS')).toBe('"QUARTZ"."QRTZ_TRIGGERS"');
    expect(set.names.schema).toBe('QUARTZ');
  });

  it('소문자 테이블명도 그대로 쓴다', () => {
    const set = createTableSet(oracleDialect, { schema: 'APP', tables: names('my_', true) });
    expect(set.table('LOCKS')).toBe('"APP"."my_locks"');
  });

  it('스키마가 없으면 테이블 이름만 쓴다', () => {
    const set = createTableSet(oracleDialect, { tables: names('QRTZ_') });
    expect(set.table('JOB_DETAILS')).toBe('"QRTZ_JOB_DETAILS"');
  });

  it('선택 테이블은 있을 때만 쓸 수 있다', () => {
    const without = createTableSet(oracleDialect, { tables: names('QRTZ_') });
    expect(without.has('SIMPROP_TRIGGERS')).toBe(false);
    expect(() => without.table('SIMPROP_TRIGGERS')).toThrow('SIMPROP_TRIGGERS');

    const withSimprop = createTableSet(oracleDialect, {
      tables: { ...names('QRTZ_'), SIMPROP_TRIGGERS: 'QRTZ_SIMPROP_TRIGGERS' },
    });
    expect(withSimprop.has('SIMPROP_TRIGGERS')).toBe(true);
  });

  it('필수 테이블이 빠지면 던진다', () => {
    const tables = names('QRTZ_');
    delete tables.LOCKS;
    expect(() => createTableSet(oracleDialect, { tables })).toThrow('LOCKS');
  });

  it('따옴표를 깨뜨리는 이름과 모르는 키를 거부한다', () => {
    expect(() =>
      createTableSet(oracleDialect, { tables: { ...names('QRTZ_'), TRIGGERS: 'X" OR 1=1 --' } }),
    ).toThrow('TRIGGERS');
    expect(() => createTableSet(oracleDialect, { schema: 'A"B', tables: names('QRTZ_') })).toThrow(
      '스키마',
    );
    expect(() =>
      createTableSet(oracleDialect, {
        tables: { ...names('QRTZ_'), ['USERS' as QuartzTableKey]: 'USERS' },
      }),
    ).toThrow('USERS');
  });
});
