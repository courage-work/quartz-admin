import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceLock, InstanceLockError } from './instance-lock.js';
import { metaDbPath, openSqlite, type Sqlite } from './meta-db.js';
import { tempDataDir } from './test-support.js';

describe('InstanceLock', () => {
  let tmp: ReturnType<typeof tempDataDir>;
  let sqlite: Sqlite;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    tmp = tempDataDir();
    sqlite = openSqlite(tmp.dir);
    clock = 1_700_000_000_000;
  });
  afterEach(() => {
    sqlite.close();
    tmp.cleanup();
  });

  const lock = (host: string, pid: number, alive = true) =>
    new InstanceLock(sqlite, { host, pid, now, isPidAlive: () => alive });

  it('비어 있으면 락을 확보하고 보유자 정보를 남긴다', () => {
    const a = lock('host-a', 100);
    a.acquire();
    expect(a.holder()).toMatchObject({ instanceId: a.instanceId, host: 'host-a', pid: 100 });
  });

  it('다른 호스트의 최근 하트비트가 있으면 보유자를 밝힌 오류로 거부한다', () => {
    lock('host-a', 100).acquire();
    clock += 20_000;
    expect(() => lock('host-b', 200).acquire()).toThrow(InstanceLockError);
    expect(() => lock('host-b', 200).acquire()).toThrow(
      /host=host-a, pid=100, 마지막 하트비트 20초 전/,
    );
  });

  it('하트비트가 30초보다 오래되면 죽은 인스턴스로 보고 인수한다', () => {
    lock('host-a', 100).acquire();
    clock += 30_001;
    const b = lock('host-b', 200);
    expect(() => b.acquire()).not.toThrow();
    expect(b.holder()?.host).toBe('host-b');
  });

  it('같은 호스트에서는 보유 프로세스가 살아 있을 때만 거부한다', () => {
    lock('host-a', 100).acquire();
    expect(() => lock('host-a', 200, true).acquire()).toThrow(InstanceLockError);
    expect(() => lock('host-a', 200, false).acquire()).not.toThrow();
  });

  it('같은 호스트·같은 pid(컨테이너 재시작)는 인수한다', () => {
    lock('host-a', 1).acquire();
    expect(() => lock('host-a', 1, true).acquire()).not.toThrow();
  });

  it('check는 테이블이 없어도 통과하고, 보유자가 있으면 거부하되 아무것도 기록하지 않는다', () => {
    expect(() => lock('host-b', 200).check()).not.toThrow();
    const a = lock('host-a', 100);
    a.acquire();
    const before = a.holder();
    clock += 5_000;
    expect(() => lock('host-b', 200).check()).toThrow(InstanceLockError);
    expect(a.holder()).toEqual(before);
  });

  it('해제하면 다른 인스턴스가 바로 확보할 수 있다', () => {
    const a = lock('host-a', 100);
    a.acquire();
    a.release();
    expect(a.holder()).toBeUndefined();
    expect(() => lock('host-b', 200).acquire()).not.toThrow();
  });

  it('락을 빼앗기면 하트비트가 실패를 알린다', () => {
    const a = lock('host-a', 100);
    a.acquire();
    expect(a.beat()).toBe(true);
    clock += 31_000;
    lock('host-b', 200).acquire();
    expect(a.beat()).toBe(false);
  });

  it('실제로 다른 프로세스가 같은 디렉터리로 기동하면 거부되고, 해제 후에는 확보한다', () => {
    const holder = new InstanceLock(sqlite);
    holder.acquire();

    const runChild = () =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import Database from 'better-sqlite3';
           const { InstanceLock } = await import(process.env.LOCK_MODULE);
           const db = new Database(process.env.DB_FILE);
           db.pragma('busy_timeout = 5000');
           try { new InstanceLock(db).acquire(); console.log('ACQUIRED'); }
           catch (e) { console.log(e.name + ': ' + e.message); process.exitCode = 3; }`,
        ],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: {
            ...process.env,
            LOCK_MODULE: new URL('./instance-lock.ts', import.meta.url).href,
            DB_FILE: metaDbPath(tmp.dir),
          },
          encoding: 'utf8',
        },
      );

    const refused = runChild();
    expect(refused.stdout).toContain('InstanceLockError');
    expect(refused.status).toBe(3);

    holder.release();
    const acquired = runChild();
    expect(acquired.stdout.trim()).toBe('ACQUIRED');
    expect(acquired.status).toBe(0);
  });
});
