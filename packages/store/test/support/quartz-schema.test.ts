import { describe, expect, it } from 'vitest';
import {
  QUARTZ_TABLES,
  quartzCatalogName,
  quartzDropStatements,
  quartzSchemaStatements,
  quartzTableName,
  readQuartzSchemaSql,
} from './quartz-schema.js';

describe('quartzSchemaStatements', () => {
  const sql = readQuartzSchemaSql('oracle');

  it('Quartz 원본에서 CREATE 문만 뽑는다', () => {
    const statements = quartzSchemaStatements(sql);
    const tables = statements.filter((s) => /^create table/i.test(s));
    const indexes = statements.filter((s) => /^create index/i.test(s));
    expect(tables).toHaveLength(QUARTZ_TABLES.length);
    expect(indexes.length).toBeGreaterThan(10);
    expect(statements.some((s) => /delete|drop/i.test(s))).toBe(false);
    expect(statements.every((s) => !s.includes('--') && !s.endsWith(';'))).toBe(true);
  });

  it('기본 prefix는 QRTZ_ 대문자다', () => {
    const create = quartzSchemaStatements(sql).find((s) =>
      s.startsWith('CREATE TABLE QRTZ_SIMPLE_TRIGGERS'),
    );
    expect(create).toBeDefined();
    expect(create).toContain('CONSTRAINT QRTZ_SIMPLE_TRIG_PK');
    expect(create).toContain('REFERENCES QRTZ_TRIGGERS(');
  });

  it('사용자 지정 prefix는 테이블, 제약 조건, 인덱스 이름에 모두 들어간다', () => {
    const statements = quartzSchemaStatements(sql, { prefix: 'APP_' }).join('\n');
    expect(statements).not.toMatch(/qrtz/i);
    expect(statements).toContain('CREATE TABLE APP_JOB_DETAILS');
    expect(statements).toContain('CONSTRAINT APP_JOB_DETAILS_PK');
    expect(statements).toContain('REFERENCES APP_JOB_DETAILS(');
    expect(statements).toContain('create index IDX_APP_T_NEXT_FIRE_TIME on APP_TRIGGERS(');
  });

  it('소문자 변형은 테이블 이름만 따옴표 소문자로 만든다', () => {
    const statements = quartzSchemaStatements(sql, { prefix: 'qa_', tableCase: 'lower' }).join(
      '\n',
    );
    expect(statements).toContain('CREATE TABLE "qa_job_details"');
    expect(statements).toContain('REFERENCES "qa_triggers"(');
    expect(statements).toContain('on "qa_fired_triggers"(');
    expect(statements).toContain('CONSTRAINT QA_TRIGGERS_PK');
    expect(statements).toContain('IDX_QA_FT_TG');
  });

  it('oracle23 변형은 불리언 컬럼이 BOOLEAN이다', () => {
    const jobDetails = quartzSchemaStatements(readQuartzSchemaSql('oracle23')).find((s) =>
      s.startsWith('CREATE TABLE QRTZ_JOB_DETAILS'),
    );
    expect(jobDetails).toMatch(/IS_DURABLE BOOLEAN NOT NULL/);
  });

  it('prefix에 식별자가 아닌 값을 넣으면 거부한다', () => {
    expect(() => quartzSchemaStatements(sql, { prefix: 'x; drop' })).toThrow();
    expect(() => quartzSchemaStatements(sql, { prefix: '1A_' })).toThrow();
  });
});

describe('테이블 이름', () => {
  it('SQL 식별자와 카탈로그 이름을 만든다', () => {
    expect(quartzTableName('TRIGGERS')).toBe('QRTZ_TRIGGERS');
    expect(quartzTableName('TRIGGERS', { prefix: 'app_' })).toBe('APP_TRIGGERS');
    expect(quartzTableName('TRIGGERS', { tableCase: 'lower' })).toBe('"qrtz_triggers"');
    expect(quartzCatalogName('LOCKS', { tableCase: 'lower' })).toBe('qrtz_locks');
  });

  it('DROP은 자식 테이블부터 한다', () => {
    const drops = quartzDropStatements();
    expect(drops).toHaveLength(QUARTZ_TABLES.length);
    expect(drops.indexOf('DROP TABLE QRTZ_SIMPLE_TRIGGERS PURGE')).toBeLessThan(
      drops.indexOf('DROP TABLE QRTZ_TRIGGERS PURGE'),
    );
    expect(drops.indexOf('DROP TABLE QRTZ_TRIGGERS PURGE')).toBeLessThan(
      drops.indexOf('DROP TABLE QRTZ_JOB_DETAILS PURGE'),
    );
  });
});
