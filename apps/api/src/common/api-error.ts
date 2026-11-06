import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorBody, ApiErrorCode } from '@qa/shared';

/** 응답 본문이 `ApiErrorBody`인 HTTP 예외. 서비스 코드는 이 예외만 던진다 */
export class ApiError extends HttpException {
  readonly code: ApiErrorCode;

  constructor(
    status: HttpStatus,
    code: ApiErrorCode,
    message: string,
    details?: ApiErrorBody['details'],
    readonly headers: Record<string, string> = {},
  ) {
    const body: ApiErrorBody = { code, message, ...(details ? { details } : {}) };
    super(body, status);
    this.code = code;
  }

  get body(): ApiErrorBody {
    return this.getResponse() as ApiErrorBody;
  }
}

export const unauthenticated = (message = '로그인이 필요합니다') =>
  new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', message);

export const forbidden = (message = '관리자만 사용할 수 있습니다') =>
  new ApiError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);

export const notFound = (message: string) =>
  new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message);
