import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { CSRF_HEADER } from '@qa/shared';
import type { Request } from 'express';
import { ApiError } from '../common/api-error.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 방어 (TRD §4.3). 상태를 바꾸는 요청은 `Origin`이 `QA_PUBLIC_URL`과 같고 `X-QA-Request: 1`이 있어야 한다.
 * `SameSite=Strict` 쿠키와 함께 이중으로 막는다. 로그인 요청에도 적용한다(로그인 CSRF 방지).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (req.headers.origin !== this.config.publicOrigin) {
      throw rejected('요청 출처(Origin)가 허용된 주소와 다릅니다');
    }
    if (req.get(CSRF_HEADER) !== '1') {
      throw rejected(`${CSRF_HEADER} 헤더가 없습니다`);
    }
    return true;
  }
}

function rejected(message: string): ApiError {
  return new ApiError(HttpStatus.FORBIDDEN, 'CSRF_REJECTED', message);
}
