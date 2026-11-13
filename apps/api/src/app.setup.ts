import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX } from '@qa/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { requestIdMiddleware } from './common/request-id.js';
import type { AppConfig } from './config/env.js';
import { HEALTH_PATHS } from './health/paths.js';
import { WebAssets, webAssetsMiddleware } from './web/web-assets.js';
import { type WebDevServer, webDevMiddleware } from './web/web-dev.js';

export interface ConfigureOptions {
  /** 웹 정적 export 결과물 디렉터리. 없거나 비어 있으면 API만 제공한다 */
  webDir?: string | null;
  /** 개발 전용. 있으면 정적 파일 대신 이 Next 개발 서버로 화면을 서빙한다(`QA_WEB_DEV`) */
  webDev?: WebDevServer | null;
}

/**
 * 제어 명령 요청 본문 상한. 실행 요청은 미리보기에서 본 대상 트리거마다의 상태(`expected`)를 담는다.
 * 스케줄러 전체 명령은 트리거 10,000개(`COMMAND_TARGETS_MAX`)에 약 680KB라 기본 상한(100KB)으로는 받을 수 없다.
 */
export const COMMAND_BODY_LIMIT = '1mb';

/**
 * HTTP 계층 설정. main.ts와 테스트가 같은 설정으로 앱을 띄우도록 한 곳에 둔다.
 */
export function configureApp(
  app: NestExpressApplication,
  config: AppConfig,
  options: ConfigureOptions = {},
): void {
  // 헬스체크는 컨테이너 런타임이 부르므로 /api/v1 밖에 둔다 (TRD §11.1)
  app.setGlobalPrefix(API_PREFIX, { exclude: HEALTH_PATHS.map((p) => p.slice(1)) });
  // 리버스 프록시 한 단계만 신뢰한다. 클라이언트가 보낸 X-Forwarded-For로 IP를 속일 수 없게 하기 위해서다
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');
  // 감사 로그와 서버 로그를 잇는 요청 ID (TRD §10, §11.3)
  app.use(requestIdMiddleware);
  // CSP default-src 'self', X-Content-Type-Options, Referrer-Policy 등 (TRD §4.3).
  // 화면 HTML은 아래 미들웨어가 파일별 CSP로 덮어쓴다
  app.use(helmet());
  // API 응답(접속 정보, 사용자, 감사 로그)은 브라우저나 중간 프록시 캐시에 남기지 않는다 (B-32, TRD §4.5)
  app.use(`/${API_PREFIX}`, (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // 제어 명령 경로만 본문 상한을 올린다. 먼저 읽어 두면 뒤의 기본 파서(100KB)는 이미 읽은 본문을 건너뛴다.
  // JSON 파서가 하나라도 등록돼 있으면 Nest가 기본 JSON 파서를 붙이지 않으므로 기본 파서도 직접 붙인다
  app.use(`/${API_PREFIX}/schedulers/:id/commands`, express.json({ limit: COMMAND_BODY_LIMIT }));
  app.useBodyParser('json');

  // 화면과 API를 같은 오리진에서 서빙한다 (TRD §2.2). Nest 라우터보다 먼저 등록된다
  if (options.webDev) {
    app.use(webDevMiddleware(options.webDev.handle, API_PREFIX));
    return;
  }
  const assets = WebAssets.load(options.webDir, config.publicUrl.startsWith('https:'));
  if (assets) {
    app.use(webAssetsMiddleware(assets, API_PREFIX));
  } else if (options.webDir) {
    new Logger('Web').warn(
      `화면 파일이 없어 API만 제공합니다: ${options.webDir} (pnpm build로 웹을 함께 빌드하세요)`,
    );
  }
}
