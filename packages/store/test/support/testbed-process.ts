import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { TestbedClient } from './testbed-client.js';
import type { TestbedDb, TestbedNode } from './testbed.js';

/** 컨테이너든 프로세스든 점검이 쓰는 테스트베드 노드 */
export type TestbedHandle = Pick<
  TestbedNode,
  'schedulerName' | 'instanceId' | 'baseUrl' | 'client' | 'stop'
>;

export interface StartTestbedProcessOptions {
  /** `quartz-testbed-<버전>.jar`가 있는 폴더 */
  jarDir: string;
  quartzVersion: string;
  db: TestbedDb;
  schedulerName: string;
  instanceId: string;
  tablePrefix: string;
  executionsTable: string;
  /** 기본 2000ms (컨테이너 방식과 같음) */
  clusterCheckinIntervalMs?: number;
  /** false면 기준 인스턴스 */
  start?: boolean;
  /** 노드 로그를 stderr로. 기본은 `QA_IT_LOGS=1`일 때만 */
  logs?: boolean;
}

const STARTUP_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;

/** 테스트베드 jar 경로. 점검 이미지는 `/opt/testbed/quartz-testbed-2.3.2.jar`처럼 버전마다 둔다 */
export function testbedJar(jarDir: string, quartzVersion: string): string {
  const jar = path.join(jarDir, `quartz-testbed-${quartzVersion}.jar`);
  if (!existsSync(jar)) {
    throw new Error(`테스트베드 jar가 없습니다: ${jar} (quartzVersion을 확인하세요)`);
  }
  return jar;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('빈 포트를 찾지 못했습니다'));
      });
    });
  });
}

async function waitHealthy(baseUrl: string, child: ChildProcess, tail: () => string) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`테스트베드가 기동 중에 끝났습니다(종료 코드 ${child.exitCode}). ${tail()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return;
    } catch {
      // 아직 포트를 열지 않았다
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `테스트베드가 ${STARTUP_TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다. ${tail()}`,
  );
}

/**
 * 테스트베드 노드를 컨테이너 대신 같은 호스트의 Java 프로세스로 띄운다 (B-35 점검 이미지).
 *
 * 사내망 PC에서 Docker 소켓·네트워크·Ryuk 없이 이미지 하나로 점검하려고 쓴다. 환경 변수는 컨테이너 방식
 * ({@link startTestbedNode})과 같고, 노드마다 빈 포트를 골라 `127.0.0.1`에서 제어 API를 연다.
 */
export async function startTestbedProcess(
  options: StartTestbedProcessOptions,
): Promise<TestbedHandle> {
  const jar = testbedJar(options.jarDir, options.quartzVersion);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TESTBED_DB_URL: options.db.jdbcUrl,
    TESTBED_DB_USER: options.db.user,
    TESTBED_DB_PASSWORD: options.db.password,
    TESTBED_SCHEDULER_NAME: options.schedulerName,
    TESTBED_INSTANCE_ID: options.instanceId,
    TESTBED_TABLE_PREFIX: options.tablePrefix,
    TESTBED_EXECUTIONS_TABLE: options.executionsTable,
    TESTBED_CLUSTER_CHECKIN_INTERVAL_MS: String(options.clusterCheckinIntervalMs ?? 2000),
    TESTBED_HTTP_PORT: String(port),
  };
  if (options.start === false) env.TESTBED_START = 'false';

  const child = spawn('java', ['-Xmx256m', '-XX:+ExitOnOutOfMemoryError', '-jar', jar, 'server'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const label = options.instanceId;
  const toStderr = options.logs ?? process.env.QA_IT_LOGS === '1';
  // 기동에 실패하면 원인을 보여 주려고 마지막 로그 몇 줄을 들고 있는다
  const recent: string[] = [];
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().trimEnd().split('\n')) {
      recent.push(line);
      if (recent.length > 20) recent.shift();
      if (toStderr) process.stderr.write(`[testbed ${label}] ${line}\n`);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const spawnError = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(new Error(`java를 실행하지 못했습니다: ${err.message}`)));
  });
  // 기동 뒤에 나는 오류는 아래 race가 이미 끝나 아무도 받지 않으므로 처리되지 않은 거부로 남기지 않는다
  spawnError.catch(() => {});
  const tail = () => (recent.length ? `마지막 로그: ${recent.slice(-5).join(' / ')}` : '');

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await Promise.race([waitHealthy(baseUrl, child, tail), spawnError]);
  } catch (err) {
    await stop();
    throw err;
  }
  const client = new TestbedClient(baseUrl);
  const metadata = await client.metadata();
  return {
    schedulerName: options.schedulerName,
    instanceId: metadata.instanceId,
    baseUrl,
    client,
    stop,
  };
}
