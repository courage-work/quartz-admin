import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TargetPoolManager,
  createDriverAdapters,
  detectQuartz,
  type QuartzDetection,
} from '../../src/index.js';
import {
  TEST_DB,
  TEST_DB_LABEL,
  initQuartzSchema,
  isMysqlFamily,
  startTestDb,
  type DbCredentials,
  type DbFixture,
} from '../support/index.js';

/**
 * 운영 문서의 DB 계정 SQL(`docs/db-accounts/*.sql`, B-36)을 그대로 실행해 본다. 만든 읽기 전용 계정은 Quartz 테이블을
 * 감지하되 쓰기 불가로, 쓰기 계정은 쓰기 가능으로 판정돼야 한다(TRD §5.5 6단계). CI 매트릭스의 모든 DB 버전에서 돈다.
 */

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/db-accounts');
const READER_PASSWORD = 'Reader_docs1';
const WRITER_PASSWORD = 'Writer_docs1';

const SQL_FILE =
  TEST_DB === 'postgres' ? 'postgresql.sql' : isMysqlFamily(TEST_DB) ? 'mysql.sql' : 'oracle.sql';

/** 주석 줄을 빼고 `;`로 끝나는 문장으로 나눈다. 바꿔 넣을 값을 채운다 */
function statements(schema: string): string[] {
  return readFileSync(join(DOCS, SQL_FILE), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replaceAll('{{SCHEMA}}', schema)
    .replaceAll('{{READER_PASSWORD}}', READER_PASSWORD)
    .replaceAll('{{WRITER_PASSWORD}}', WRITER_PASSWORD)
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe(`운영 문서의 DB 계정 SQL (${TEST_DB_LABEL})`, () => {
  let db: DbFixture;
  let pools: TargetPoolManager;

  const accounts: Record<'reader' | 'writer', DbCredentials> =
    TEST_DB === 'oracle'
      ? {
          reader: { user: 'QA_READER', password: READER_PASSWORD },
          writer: { user: 'QA_WRITER', password: WRITER_PASSWORD },
        }
      : {
          reader: { user: 'qa_reader', password: READER_PASSWORD },
          writer: { user: 'qa_writer', password: WRITER_PASSWORD },
        };

  const detect = (credentials: DbCredentials): Promise<QuartzDetection> =>
    pools.withConnection({ id: credentials.user, info: db.targetInfo(credentials) }, (conn) =>
      detectQuartz(conn, db.dialect, { schema: db.schema }),
    );

  /** 문서대로 DB 관리자(Oracle SYSTEM, PostgreSQL 슈퍼유저, MySQL root)로 실행한다 */
  async function runAsAdmin(sql: string[]): Promise<void> {
    if (TEST_DB === 'oracle') {
      await db.oracle!.withSystemConnection(async (conn) => {
        for (const s of sql) await conn.execute(s);
      });
    } else if (isMysqlFamily(TEST_DB)) {
      const root = await db.mysql!.connectRoot();
      try {
        for (const s of sql) await root.query(s);
      } finally {
        await root.end();
      }
    } else {
      await db.withConnection(async (conn) => {
        for (const s of sql) await conn.execute(s);
        await conn.commit();
      });
    }
  }

  beforeAll(async () => {
    db = await startTestDb();
    pools = new TargetPoolManager(createDriverAdapters());
    await db.withConnection((conn) => initQuartzSchema(conn));
    await runAsAdmin(statements(db.schema));
  });

  afterAll(async () => {
    await pools?.closeAll();
    await db?.stop();
  });

  it('읽기 전용 계정은 Quartz 테이블을 감지하고 쓰기 불가로 판정된다', async () => {
    const detection = await detect(accounts.reader);
    const set = detection.tableSets.find((s) => s.prefix.toUpperCase() === 'QRTZ_');
    expect(set, JSON.stringify(detection)).toBeDefined();
    expect(set!.writeCapable).toBe(false);
    expect(set!.missingPrivileges.some((m) => m.privilege === 'SELECT')).toBe(false);
    expect(set!.missingPrivileges.length).toBeGreaterThan(0);
  });

  it('쓰기 계정은 쓰기 가능으로 판정되고 빠진 권한이 없다', async () => {
    const detection = await detect(accounts.writer);
    const set = detection.tableSets.find((s) => s.prefix.toUpperCase() === 'QRTZ_');
    expect(set, JSON.stringify(detection)).toBeDefined();
    expect(set!.writeCapable).toBe(true);
    expect(set!.missingPrivileges).toEqual([]);
  });
});
