import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from '../support/index.js';

/** 빌드한 API(`pnpm build`). 측정은 운영과 같은 실행 파일로 한다 */
export const API_MAIN = fileURLToPath(
  new URL('../../../../apps/api/dist/main.js', import.meta.url),
);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiOptions {
  /** API 표준 출력·오류를 남길 파일 */
  logFile: string;
  monitorConcurrency?: number;
  env?: Record<string, string>;
}

/**
 * 빌드한 API를 임시 데이터 폴더로 띄운다. 암호화 키와 관리자 계정은 매번 새로 만든다(이 프로세스 밖으로 내보내지 않는다).
 * 끝나면 {@link RunningApi.stop}이 프로세스를 끝내고 데이터 폴더를 지운다
 */
export async function startApi(options: ApiOptions): Promise<RunningApi> {
  if (!existsSync(API_MAIN)) {
    throw new Error(`${API_MAIN}가 없습니다. 먼저 pnpm build를 실행하세요`);
  }
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'qa-perf-'));
  const baseUrl = `http://localhost:${port}`;
  const admin = { username: 'perf-admin', password: randomBytes(18).toString('base64url') };
  const log = createWriteStream(options.logFile, { flags: 'a' });
  const child = spawn(process.execPath, [API_MAIN], {
    cwd: path.dirname(path.dirname(API_MAIN)),
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      PORT: String(port),
      QA_PUBLIC_URL: baseUrl,
      QA_DATA_DIR: dataDir,
      QA_ENCRYPTION_KEYS: `perf:${randomBytes(32).toString('base64')}`,
      QA_ENCRYPTION_ACTIVE_KEY: 'perf',
      QA_ADMIN_USERNAME: admin.username,
      QA_ADMIN_PASSWORD: admin.password,
      QA_LOG_LEVEL: 'info',
      QA_MONITOR_CONCURRENCY: String(options.monitorConcurrency ?? 8),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const api = new RunningApi(child, baseUrl, dataDir, admin, log);
  try {
    await api.waitHealthy();
    await api.login();
  } catch (err) {
    await api.stop();
    throw err;
  }
  return api;
}

export class RunningApi {
  private cookie = '';

  constructor(
    private readonly child: ChildProcess,
    readonly baseUrl: string,
    private readonly dataDir: string,
    private readonly admin: { username: string; password: string },
    private readonly log: NodeJS.WritableStream,
  ) {}

  async waitHealthy(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`API가 종료됐습니다(코드 ${this.child.exitCode}). 로그를 확인하세요`);
      }
      try {
        const res = await fetch(`${this.baseUrl}/healthz`);
        if (res.ok) return;
      } catch {
        // 아직 기동 중
      }
      await sleep(500);
    }
    throw new Error('API가 제한 시간 안에 뜨지 않았습니다');
  }

  async login(): Promise<void> {
    const res = await this.raw('POST', '/auth/login', this.admin);
    const setCookie = res.headers.getSetCookie();
    this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    if (!res.ok) throw new Error(`로그인 실패: ${res.status}`);
  }

  private raw(method: string, pathname: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/api/v1${pathname}`, {
      method,
      headers: {
        Origin: this.baseUrl,
        'X-QA-Request': '1',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, pathname, body);
    const text = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { code?: string }).code;
      } catch {
        // 본문이 JSON이 아님
      }
      throw new ApiError(
        res.status,
        code,
        `${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** 화면 확인용으로 API를 붙잡아 둘 때 파일에 남기는 접속 정보. 생성한 테스트 계정이다 */
  holdInfo(): { baseUrl: string; username: string; password: string } {
    return { baseUrl: this.baseUrl, ...this.admin };
  }

  get<T>(pathname: string): Promise<T> {
    return this.request<T>('GET', pathname);
  }

  post<T>(pathname: string, body: unknown): Promise<T> {
    return this.request<T>('POST', pathname, body);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null) {
      const exited = new Promise((resolve) => this.child.once('exit', resolve));
      this.child.kill();
      await Promise.race([exited, sleep(10_000)]);
    }
    this.log.end();
    rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
