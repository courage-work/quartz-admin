import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER } from '@qa/shared';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app.setup.js';
import { CLOCK } from '../common/clock.js';
import type { AppConfig } from '../config/env.js';
import { testConfig } from '../config/test-support.js';
import { tempDataDir } from '../meta-db/test-support.js';
import { LOGIN_RATE_LIMITER } from './auth.controller.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';

export const ADMIN = { username: 'admin', password: 'admin-password-1' } as const;

/**
 * 테스트 로그 출력 대상. nestjs-pino는 프로세스(테스트 파일)마다 pino-http 인스턴스를 하나만 만들고
 * 처음 만든 앱의 출력 대상을 계속 쓰므로, 모든 테스트 앱이 이 객체 하나를 공유한다.
 * `createTestApp`이 앱을 만들 때마다 비운다.
 */
export const testLogs = {
  lines: [] as Record<string, unknown>[],
  write(line: string): void {
    testLogs.lines.push(JSON.parse(line) as Record<string, unknown>);
  },
  /** 접근 로그(요청 한 건당 한 줄)만 */
  access(): Record<string, unknown>[] {
    return testLogs.lines.filter((l) => typeof l.durationMs === 'number');
  },
  clear(): void {
    testLogs.lines.length = 0;
  },
};

export interface TestApp {
  app: NestExpressApplication;
  config: AppConfig;
  /** 테스트가 움직이는 현재 시각 */
  clock: { now: number; advance(ms: number): void };
  /** CSRF 헤더를 갖춘 요청. `cookie`를 주면 세션 쿠키로 붙인다 */
  get(path: string, cookie?: string): request.Test;
  send(
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    cookie?: string,
  ): request.Test;
  /** 로그인하고 `qa_sid=...` 쿠키 문자열을 돌려준다 */
  login(username: string, password: string): Promise<string>;
  close(): Promise<void>;
}

/** 실제 AppModule과 HTTP 설정(main.ts와 같음)으로 앱을 띄운다 */
export async function createTestApp(
  options: {
    config?: Partial<AppConfig>;
    dataDir?: string;
    loginRateLimit?: number;
    /** 화면 정적 파일 디렉터리 (web/web-assets.ts) */
    webDir?: string;
  } = {},
): Promise<TestApp> {
  const tmp = options.dataDir ? undefined : tempDataDir();
  const config = testConfig({
    dataDir: options.dataDir ?? tmp!.dir,
    admin: { ...ADMIN },
    ...options.config,
  });
  const clock = {
    now: Date.UTC(2026, 10, 6, 0, 0, 0),
    advance(ms: number) {
      this.now += ms;
    },
  };
  testLogs.clear();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config, { logStream: testLogs })],
  })
    .overrideProvider(CLOCK)
    .useValue(() => clock.now)
    .overrideProvider(LOGIN_RATE_LIMITER)
    .useValue(new FixedWindowRateLimiter(options.loginRateLimit ?? 1_000, 60_000))
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, config, { webDir: options.webDir ?? null });
  await app.init();
  const server = app.getHttpServer();

  const withCookie = (req: request.Test, cookie?: string) =>
    cookie ? req.set('Cookie', cookie) : req;

  const t: TestApp = {
    app,
    config,
    clock,
    get: (path, cookie) => withCookie(request(server).get(`/api/v1${path}`), cookie),
    send: (method, path, body, cookie) => {
      const req = request(server)
        [method](`/api/v1${path}`)
        .set('Origin', config.publicOrigin)
        .set(CSRF_HEADER, '1');
      return withCookie(body === undefined ? req : req.send(body), cookie);
    },
    async login(username, password) {
      const res = await t.send('post', '/auth/login', { username, password }).expect(200);
      return sessionCookie(res);
    },
    async close() {
      await app.close();
      tmp?.cleanup();
    },
  };
  return t;
}

/** 응답의 Set-Cookie에서 `qa_sid=<토큰>`만 뽑는다 */
export function sessionCookie(res: request.Response): string {
  const raw = setCookies(res).find((c) => c.startsWith('qa_sid='));
  if (!raw) throw new Error('qa_sid 쿠키가 없습니다');
  return raw.split(';')[0]!;
}

export function setCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}
