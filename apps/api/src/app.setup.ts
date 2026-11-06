import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX } from '@qa/shared';
import helmet from 'helmet';
import type { AppConfig } from './config/env.js';

/**
 * HTTP 계층 설정. main.ts와 테스트가 같은 설정으로 앱을 띄우도록 한 곳에 둔다.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.setGlobalPrefix(API_PREFIX);
  // 리버스 프록시 한 단계만 신뢰한다. 클라이언트가 보낸 X-Forwarded-For로 IP를 속일 수 없게 하기 위해서다
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');
  // CSP default-src 'self', X-Content-Type-Options, Referrer-Policy 등 (TRD §4.3)
  app.use(helmet());
}
