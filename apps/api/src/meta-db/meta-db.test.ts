import { eq } from 'drizzle-orm';
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMetaDb,
  metaDbPath,
  openSqlite,
  runMigrations,
  type MetaDb,
  type Sqlite,
} from './meta-db.js';
import { alertRules, alerts, connections, schedulers } from './schema.js';
import { tempDataDir } from './test-support.js';

const EXPECTED_TABLES = [
  'alert_reads',
  'alert_rule_channels',
  'alert_rules',
  'alerts',
  'audit_logs',
  'channels',
  'connections',
  'known_nodes',
  'notifications',
  'scheduler_snapshots',
  'schedulers',
  'sessions',
  'settings',
  'trigger_observations',
  'users',
];

function open(dir: string): { sqlite: Sqlite; db: MetaDb } {
  const sqlite = openSqlite(dir);
  const db = createMetaDb(sqlite);
  runMigrations(db);
  return { sqlite, db };
}

function tableNames(sqlite: Sqlite): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe('메타데이터 저장소', () => {
  let tmp: ReturnType<typeof tempDataDir>;
  beforeEach(() => {
    tmp = tempDataDir();
  });
  afterEach(() => tmp.cleanup());

  it('빈 디렉터리에서 열면 TRD §3.2의 테이블을 모두 만든다', () => {
    const { sqlite } = open(tmp.dir);
    expect(tableNames(sqlite)).toEqual(EXPECTED_TABLES);
    sqlite.close();
  });

  it('다시 열어도 마이그레이션을 중복 적용하지 않는다', () => {
    const first = open(tmp.dir);
    const applied = first.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get();
    first.sqlite.close();

    const second = open(tmp.dir);
    expect(second.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual(
      applied,
    );
    expect(tableNames(second.sqlite)).toEqual(EXPECTED_TABLES);
    second.sqlite.close();
  });

  it('WAL, synchronous=NORMAL, 외래키, busy_timeout을 설정한다', () => {
    const { sqlite } = open(tmp.dir);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('synchronous', { simple: true })).toBe(1);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    sqlite.close();
  });

  it('DB 파일 권한을 600으로 둔다', () => {
    const { sqlite } = open(tmp.dir);
    expect(statSync(metaDbPath(tmp.dir)).mode & 0o777).toBe(0o600);
    sqlite.close();
  });

  describe('스키마 제약', () => {
    let sqlite: Sqlite;
    let db: MetaDb;
    let schedulerId: number;
    const now = 1_700_000_000_000;

    beforeEach(() => {
      ({ sqlite, db } = open(tmp.dir));
      const [conn] = db
        .insert(connections)
        .values({
          name: 'billing-prod',
          dbType: 'oracle',
          host: 'db.internal',
          port: 1521,
          username: 'quartz_ro',
          passwordEnc: 'v1:k1:iv:tag:ct',
          envLabel: 'prod',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();
      const [sched] = db
        .insert(schedulers)
        .values({
          connectionId: conn!.id,
          tablePrefix: 'QRTZ_',
          tableNames: { TRIGGERS: 'QRTZ_TRIGGERS' },
          schedName: 'billing',
          displayName: 'billing',
          features: { simpropTriggers: true },
          boolFormat: '10',
          expectedNodeCount: 2,
          detectedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();
      schedulerId = sched!.id;
    });
    afterEach(() => sqlite.close());

    it('JSON 컬럼과 기본값을 저장하고 읽는다', () => {
      const conn = db.select().from(connections).get();
      expect(conn?.tags).toEqual([]);
      expect(conn?.options).toEqual({});
      expect(conn?.readOnly).toBe(false);
      expect(conn?.writeCapable).toBeNull();
      const sched = db.select().from(schedulers).get();
      expect(sched?.tableNames).toEqual({ TRIGGERS: 'QRTZ_TRIGGERS' });
      expect(sched?.misfireThresholdMs).toBe(60_000);
    });

    it('접속을 지우면 하위 스케줄러도 지워진다', () => {
      db.delete(connections).run();
      expect(db.select().from(schedulers).all()).toHaveLength(0);
    });

    it('열린 알림은 (규칙, 지문)마다 하나만 허용하고, 해소된 알림은 새로 열 수 있다', () => {
      const [rule] = db
        .insert(alertRules)
        .values({
          schedulerId,
          type: 'OVERDUE',
          severity: 'warning',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();
      const openAlert = {
        schedulerId,
        ruleId: rule!.id,
        fingerprint: 'rule',
        type: 'OVERDUE' as const,
        severity: 'warning' as const,
        status: 'open' as const,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      const [first] = db.insert(alerts).values(openAlert).returning().all();
      expect(() => db.insert(alerts).values(openAlert).run()).toThrow(/UNIQUE/);

      db.update(alerts)
        .set({ status: 'resolved', resolvedAt: now })
        .where(eq(alerts.id, first!.id))
        .run();
      expect(() => db.insert(alerts).values(openAlert).run()).not.toThrow();
    });
  });
});
