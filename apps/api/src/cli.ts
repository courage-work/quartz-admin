/**
 * 운영 CLI: `node dist/cli.js <command>`
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ResetPasswordError, resetPasswordOffline } from './auth/reset-password.js';
import { ConfigError, ENCRYPTION_KEY_BYTES, loadConfig, loadDataDir } from './config/env.js';
import { RotationError, rotateSecrets } from './crypto/rotate-keys.js';
import { SecretBox } from './crypto/secret-box.js';
import { backupDir, backupTo, createBackup, pruneBackups } from './meta-db/backup.js';
import { InstanceLock, InstanceLockError } from './meta-db/instance-lock.js';
import { createMetaDb, metaDbPath, openSqlite, runMigrations } from './meta-db/meta-db.js';

const USAGE = `사용법: node dist/cli.js <command>

  backup [--out <file>]   메타데이터 저장소를 온라인 백업합니다 (기본 위치: $QA_DATA_DIR/backups/)
  gen-key [--id <keyId>]  QA_ENCRYPTION_KEYS에 넣을 새 암호화 키를 만듭니다 (기본 ID: k1)
  rotate-keys [--dry-run] 기존 암호문을 QA_ENCRYPTION_ACTIVE_KEY로 재암호화합니다
                          (quartz-admin을 멈춘 상태에서 실행)
  reset-password --username <아이디>
                          임시 비밀번호를 만들어 출력하고 잠금을 풀고 세션을 끊습니다
                          (관리자 비밀번호 분실용, quartz-admin을 멈춘 상태에서 실행)`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 다음에 값이 필요합니다`);
  return value;
}

async function backup(args: string[]): Promise<void> {
  const dataDir = loadDataDir(process.env);
  const file = metaDbPath(dataDir);
  if (!existsSync(file)) {
    throw new Error(`메타데이터 파일이 없습니다: ${file} (QA_DATA_DIR를 확인하세요)`);
  }
  const out = option(args, '--out');
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (out) {
      console.log(await backupTo(sqlite, out));
    } else {
      const dir = backupDir(dataDir);
      console.log(await createBackup(sqlite, dir));
      pruneBackups(dir);
    }
  } finally {
    sqlite.close();
  }
}

function genKey(args: string[]): void {
  const id = option(args, '--id') ?? 'k1';
  console.log(`${id}:${randomBytes(ENCRYPTION_KEY_BYTES).toString('base64')}`);
}

function rotateKeys(args: string[]): void {
  const config = loadConfig(process.env);
  const box = new SecretBox(config.encryption.keys, config.encryption.activeKeyId);
  const dryRun = args.includes('--dry-run');

  const sqlite = openSqlite(config.dataDir);
  // 실행 중인 서버가 있으면 거부한다. 실행 중에는 서버도 이 락을 다시 잡을 수 없다
  const lock = new InstanceLock(sqlite);
  try {
    lock.acquire();
    const db = createMetaDb(sqlite);
    runMigrations(db);
    const report = rotateSecrets(db, box, { dryRun });
    console.log(
      `${dryRun ? '[dry-run] ' : ''}활성 키 ${report.activeKeyId}: ` +
        `전체 ${report.scanned}개, 재암호화 ${report.rotated}개, 이미 최신 ${report.alreadyCurrent}개`,
    );
  } finally {
    lock.release();
    sqlite.close();
  }
}

async function resetPassword(args: string[]): Promise<void> {
  const username = option(args, '--username');
  if (!username) throw new Error('--username <아이디>가 필요합니다');
  const dataDir = loadDataDir(process.env);
  if (!existsSync(metaDbPath(dataDir))) {
    throw new Error(
      `메타데이터 파일이 없습니다: ${metaDbPath(dataDir)} (QA_DATA_DIR를 확인하세요)`,
    );
  }
  const sqlite = openSqlite(dataDir);
  // 실행 중인 서버가 있으면 거부한다. 서버의 세션 캐시와 어긋나지 않게 하기 위해서다
  const lock = new InstanceLock(sqlite);
  try {
    lock.acquire();
    const db = createMetaDb(sqlite);
    runMigrations(db);
    const result = await resetPasswordOffline(db, username, Date.now());
    console.log(`${result.username}의 임시 비밀번호: ${result.password}`);
    console.log(
      `잠금을 풀고 세션 ${result.revokedSessions}개를 끊었습니다. 로그인한 뒤 바로 비밀번호를 바꾸세요.`,
    );
    if (!result.active) {
      console.log(
        '비활성 계정이라 이대로는 로그인할 수 없습니다. 다른 관리자가 다시 활성화해야 합니다.',
      );
    }
  } finally {
    lock.release();
    sqlite.close();
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'backup':
      await backup(args);
      break;
    case 'gen-key':
      genKey(args);
      break;
    case 'rotate-keys':
      rotateKeys(args);
      break;
    case 'reset-password':
      await resetPassword(args);
      break;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof InstanceLockError) {
    console.error(`${err.message}\n${command}는 quartz-admin을 멈춘 상태에서 실행하세요.`);
  } else if (
    err instanceof ConfigError ||
    err instanceof RotationError ||
    err instanceof ResetPasswordError ||
    err instanceof Error
  ) {
    console.error(err.message);
  } else {
    console.error(String(err));
  }
  process.exitCode = 1;
}
