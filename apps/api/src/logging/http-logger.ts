import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request } from 'express';
import type { Params } from 'nestjs-pino';
import type { DestinationStream, LoggerOptions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { AuthedRequest } from '../auth/decorators.js';
import { requestIdOf } from '../common/request-id.js';
import type { AppConfig } from '../config/env.js';
import { HEALTH_PATHS } from '../health/paths.js';

export const LOG_CENSOR = '***';

/**
 * 로그에서 가릴 경로 (TRD §11.3, NFR-SEC-03).
 * 요청·응답 직렬화는 헤더를 남기지 않지만, 코드가 객체를 그대로 로그에 넘기는 경우를 막기 위해 둔다.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'currentPassword',
  'newPassword',
  'passwordEnc',
  'password_enc',
  'configEnc',
  'config_enc',
  'authorization',
  'cookie',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordEnc',
  '*.password_enc',
  '*.configEnc',
  '*.config_enc',
  '*.authorization',
  '*.cookie',
];

export function pinoOptions(level: AppConfig['logLevel']): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: LOG_CENSOR },
    // 시각은 ISO 문자열로 남겨 사람이 읽기 쉽게 한다
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
  };
}

/**
 * pino-http 설정. 접근 로그 한 줄에 requestId, userId, method, url, statusCode, durationMs가 남는다.
 * 쿼리 문자열과 헤더는 남기지 않는다(비밀값이 섞일 수 있음).
 */
export function httpLoggerParams(
  config: Pick<AppConfig, 'logLevel'>,
  stream?: DestinationStream,
): Params {
  const options: PinoHttpOptions = {
    ...pinoOptions(config.logLevel),
    // 요청 ID 미들웨어(common/request-id.ts)가 먼저 붙인 값을 그대로 쓴다
    genReqId: (req) => requestIdOf(req as Request) ?? randomUUID(),
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    // 헬스체크는 몇 초마다 불리므로 접근 로그에서 뺀다
    autoLogging: {
      ignore: (req) => HEALTH_PATHS.includes((req.url ?? '').split('?')[0] ?? ''),
    },
    quietReqLogger: true,
    customProps: (req) => {
      const userId = (req as AuthedRequest).auth?.user.id;
      return userId === undefined ? {} : { userId };
    },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : 'info'),
    customSuccessMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
    serializers: {
      req: (req: IncomingMessage & { id?: unknown }) => ({ method: req.method, url: pathOf(req) }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
    },
  };
  return {
    pinoHttp: stream ? [options, stream] : options,
    // Nest 로그의 context(클래스 이름)를 `context` 키로 남긴다
    renameContext: 'context',
  };
}

function pathOf(req: IncomingMessage): string {
  const url = (req as Request).originalUrl ?? req.url ?? '';
  return url.split('?')[0] ?? '';
}
