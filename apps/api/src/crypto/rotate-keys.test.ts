import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMetaDb,
  openSqlite,
  runMigrations,
  type MetaDb,
  type Sqlite,
} from '../meta-db/meta-db.js';
import { channels, connections } from '../meta-db/schema.js';
import { tempDataDir } from '../meta-db/test-support.js';
import { RotationError, rotateSecrets } from './rotate-keys.js';
import { SecretBox, secretAad } from './secret-box.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const oldBox = new SecretBox(new Map([['k1', k1]]), 'k1');
const newBox = new SecretBox(
  new Map([
    ['k1', k1],
    ['k2', k2],
  ]),
  'k2',
);

describe('rotateSecrets', () => {
  let tmp: ReturnType<typeof tempDataDir>;
  let sqlite: Sqlite;
  let db: MetaDb;

  beforeEach(() => {
    tmp = tempDataDir();
    sqlite = openSqlite(tmp.dir);
    db = createMetaDb(sqlite);
    runMigrations(db);
    // 실제 등록 흐름처럼: 행을 먼저 넣고 id로 AAD를 만들어 같은 트랜잭션에서 암호문을 채운다
    for (const [name, password] of [
      ['a', 'pw-a'],
      ['b', 'pw-b'],
    ] as const) {
      const [row] = db
        .insert(connections)
        .values({
          name,
          dbType: 'oracle',
          host: 'h',
          port: 1521,
          username: 'u',
          passwordEnc: '',
          envLabel: 'dev',
          createdAt: 0,
          updatedAt: 0,
        })
        .returning()
        .all();
      db.update(connections)
        .set({ passwordEnc: oldBox.encrypt(password, secretAad('connections', row!.id)) })
        .where(eq(connections.id, row!.id))
        .run();
    }
    const [ch] = db
      .insert(channels)
      .values({ type: 'slack', name: 'ops', configEnc: '', createdAt: 0, updatedAt: 0 })
      .returning()
      .all();
    db.update(channels)
      .set({
        configEnc: oldBox.encrypt(
          '{"webhookUrl":"https://hooks/x"}',
          secretAad('channels', ch!.id),
        ),
      })
      .run();
  });
  afterEach(() => {
    sqlite.close();
    tmp.cleanup();
  });

  const tokens = () => ({
    connections: db.select().from(connections).all(),
    channels: db.select().from(channels).all(),
  });

  it('기존 암호문을 모두 새 활성 키로 재암호화하고 평문은 그대로다', () => {
    const report = rotateSecrets(db, newBox);
    expect(report).toEqual({
      dryRun: false,
      activeKeyId: 'k2',
      scanned: 3,
      rotated: 3,
      alreadyCurrent: 0,
    });

    const { connections: conns, channels: chans } = tokens();
    for (const c of conns) {
      expect(newBox.keyIdOf(c.passwordEnc)).toBe('k2');
      expect(newBox.decrypt(c.passwordEnc, secretAad('connections', c.id))).toBe(`pw-${c.name}`);
    }
    expect(newBox.decrypt(chans[0]!.configEnc, secretAad('channels', chans[0]!.id))).toContain(
      'hooks/x',
    );

    // 교체 후에는 이전 키를 빼도 모두 읽을 수 있다
    const onlyK2 = new SecretBox(new Map([['k2', k2]]), 'k2');
    for (const c of conns) {
      expect(() => onlyK2.decrypt(c.passwordEnc, secretAad('connections', c.id))).not.toThrow();
    }
    // 다시 실행하면 바꿀 것이 없다
    expect(rotateSecrets(db, newBox)).toMatchObject({ rotated: 0, alreadyCurrent: 3 });
  });

  it('--dry-run은 개수만 세고 아무것도 바꾸지 않는다', () => {
    const before = tokens();
    expect(rotateSecrets(db, newBox, { dryRun: true })).toMatchObject({ dryRun: true, rotated: 3 });
    expect(tokens()).toEqual(before);
  });

  it('하나라도 복호화하지 못하면 아무것도 바꾸지 않고 실패한 행을 알려준다', () => {
    // 다른 행에서 옮겨 붙인 암호문(AAD 불일치)
    const { connections: conns } = tokens();
    db.update(connections)
      .set({ passwordEnc: conns[0]!.passwordEnc })
      .where(eq(connections.id, conns[1]!.id))
      .run();
    const before = tokens();

    let error: unknown;
    try {
      rotateSecrets(db, newBox);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(RotationError);
    expect((error as RotationError).failures).toEqual([
      { table: 'connections', id: conns[1]!.id, reason: '암호문 검증에 실패했습니다' },
    ]);
    expect(tokens()).toEqual(before);
  });
});
