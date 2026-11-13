/**
 * E2E가 쓰는 대상(Quartz 테스트베드)과 앱(빌드한 API + 화면)을 띄우고 내린다.
 *
 * - 테스트베드: `E2E_TESTBED_INFO`에 이미 띄운 테스트베드의 접속 정보 파일을 주면 그것을 쓴다. 없으면
 *   `pnpm --filter @qa/store testbed:up`(DB는 `QA_IT_DB`, 기본 Oracle)을 띄우고 접속 정보가 나올 때까지 기다린다
 * - 앱: `apps/api/dist/main.js`를 임시 데이터 디렉터리와 이번 실행에서 만든 암호화 키·관리자 계정으로 띄운다.
 *   값은 환경 변수로만 넘기고 파일에 남기지 않는다. 먼저 `pnpm build`가 필요하다
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const RUN_DIR = join(ROOT, 'e2e', '.run');

export interface TestbedInfo {
  dbType: 'oracle' | 'postgresql' | 'mysql' | 'mariadb';
  host: string;
  port: number;
  oracleServiceName?: string;
  database?: string;
  username: string;
  password: string;
  schedulerName: string;
  nodes: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(1_000);
  }
  throw new Error(`${what}을(를) ${Math.round(ms / 1000)}초 안에 확인하지 못했습니다`);
}

/** 자식 프로세스 출력은 `.run/<name>.log`에 남긴다(CI 실패 때 올린다) */
function run(
  name: string,
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const log = createWriteStream(join(RUN_DIR, `${name}.log`));
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    // Windows에서 pnpm은 .cmd라 셸로 띄운다
    shell: process.platform === 'win32' && command === 'pnpm',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<void>((r) => {
    if (child.exitCode !== null || child.signalCode !== null) r();
    else child.once('exit', () => r());
  });

export interface Testbed {
  info: TestbedInfo;
  stop: () => Promise<void>;
}

export async function startTestbed(): Promise<Testbed> {
  const given = process.env.E2E_TESTBED_INFO;
  if (given) {
    return { info: JSON.parse(readFileSync(given, 'utf8')) as TestbedInfo, stop: async () => {} };
  }
  const infoFile = join(RUN_DIR, 'testbed.json');
  const stopFile = join(RUN_DIR, 'testbed.stop');
  rmSync(infoFile, { force: true });
  rmSync(stopFile, { force: true });
  const child = run('testbed', 'pnpm', ['--filter', '@qa/store', 'testbed:up'], {
    cwd: ROOT,
    env: {
      ...process.env,
      QA_TESTBED_INFO: infoFile,
      QA_TESTBED_STOP: stopFile,
      QA_TESTBED_MINUTES: '90',
    },
  });
  try {
    await waitFor(
      () => {
        if (child.exitCode !== null)
          throw new Error('테스트베드가 먼저 끝났습니다. .run/testbed.log를 보세요');
        return existsSync(infoFile);
      },
      15 * 60_000,
      '테스트베드 준비',
    );
  } catch (err) {
    child.kill();
    throw err;
  }
  return {
    info: JSON.parse(readFileSync(infoFile, 'utf8')) as TestbedInfo,
    stop: async () => {
      writeFileSync(stopFile, '');
      await Promise.race([exited(child), sleep(120_000)]);
      if (child.exitCode === null) child.kill();
    },
  };
}

export interface App {
  baseURL: string;
  admin: { username: string; password: string };
  stop: () => Promise<void>;
}

export async function startApp(port: number): Promise<App> {
  const main = join(ROOT, 'apps', 'api', 'dist', 'main.js');
  const web = join(ROOT, 'apps', 'api', 'public', 'index.html');
  if (!existsSync(main) || !existsSync(web)) {
    throw new Error('빌드한 앱이 없습니다. 먼저 pnpm build를 실행하세요');
  }
  const baseURL = `http://localhost:${port}`;
  const dataDir = join(RUN_DIR, `data-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  const admin = { username: 'e2e-admin', password: randomBytes(18).toString('base64url') };
  const child = run('app', process.execPath, [main], {
    cwd: join(ROOT, 'apps', 'api'),
    env: {
      ...process.env,
      PORT: String(port),
      QA_PUBLIC_URL: baseURL,
      QA_DATA_DIR: dataDir,
      QA_ENCRYPTION_KEYS: `e2e:${randomBytes(32).toString('base64')}`,
      QA_ENCRYPTION_ACTIVE_KEY: 'e2e',
      QA_ADMIN_USERNAME: admin.username,
      QA_ADMIN_PASSWORD: admin.password,
      QA_LOG_LEVEL: 'warn',
    },
  });
  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error('앱이 먼저 끝났습니다. .run/app.log를 보세요');
        const res = await fetch(`${baseURL}/healthz`).catch(() => null);
        return res?.ok === true;
      },
      120_000,
      '앱 기동',
    );
  } catch (err) {
    child.kill();
    throw err;
  }
  return {
    baseURL,
    admin,
    stop: async () => {
      child.kill();
      await Promise.race([exited(child), sleep(10_000)]);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
