import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { ConfigError } from '../config/env.js';
import { HEALTH_PATHS } from '../health/paths.js';

/** `apps/web`. dist/web(빌드)와 src/web(테스트) 모두 세 단계 위에 있다 */
export function defaultWebSourceDir(): string {
  return fileURLToPath(new URL('../../../web', import.meta.url));
}

type NextRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** 여기서 쓰는 Next 커스텀 서버 API만 적는다(`next`의 기본 내보내기) */
interface NextCustomServer {
  prepare(): Promise<void>;
  getRequestHandler(): NextRequestHandler;
  close(): Promise<void>;
}
type CreateNext = (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => NextCustomServer;

export interface WebDevServer {
  handle: NextRequestHandler;
  close(): Promise<void>;
}

/**
 * Next 개발 서버를 이 프로세스 안에 띄운다(`QA_WEB_DEV=1`, 개발 전용). 화면과 API가 한 포트를 쓰면서
 * 화면 코드를 고치면 바로 반영된다(HMR). HMR WebSocket은 Next가 첫 요청 때 HTTP 서버에 직접 붙인다.
 *
 * `next`는 `apps/web`의 의존성을 그대로 불러 쓴다. API 패키지에 넣지 않는 이유는 운영 이미지에 들어가지 않게 하고,
 * 화면과 같은 react 인스턴스를 쓰기 위해서다.
 */
export async function startWebDev(dir: string, port: number): Promise<WebDevServer> {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) {
    throw new ConfigError([
      `QA_WEB_DEV: 웹 소스(${dir})가 없습니다. 저장소에서 개발할 때만 켤 수 있습니다`,
    ]);
  }
  const createNext = createRequire(manifest)('next') as CreateNext;
  const app = createNext({ dev: true, dir, hostname: 'localhost', port });
  await app.prepare();
  return { handle: app.getRequestHandler(), close: () => app.close() };
}

/**
 * `/api`와 헬스체크 밖의 요청을 Next 개발 서버로 넘긴다. Nest 라우터보다 먼저 등록한다.
 * Next 개발 서버는 HMR과 React Refresh에 eval과 인라인 스크립트를 쓰므로, helmet이 붙인 CSP를 이 요청에서만 뺀다.
 * 운영 서빙(`webAssetsMiddleware`)의 파일별 CSP와는 상관없다.
 */
export function webDevMiddleware(handle: NextRequestHandler, apiPrefix: string) {
  const api = `/${apiPrefix}`;
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path;
    if (path === api || path.startsWith(`${api}/`) || HEALTH_PATHS.includes(path)) {
      next();
      return;
    }
    res.removeHeader('Content-Security-Policy');
    handle(req, res).catch(next);
  };
}
