import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorBody, ApiErrorCode } from '@qa/shared';
import type { Response } from 'express';
import { ApiError } from './api-error.js';

const CODE_BY_STATUS: Partial<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'VALIDATION_FAILED',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

const MESSAGE_BY_CODE: Partial<Record<ApiErrorCode, string>> = {
  VALIDATION_FAILED: '요청 형식이 올바르지 않습니다',
  UNAUTHENTICATED: '로그인이 필요합니다',
  FORBIDDEN: '권한이 없습니다',
  NOT_FOUND: '요청한 경로를 찾을 수 없습니다',
  RATE_LIMITED: '요청이 너무 많습니다. 잠시 후 다시 시도하세요',
};

/**
 * 모든 오류를 `ApiErrorBody`로 응답한다.
 * Nest 기본 예외(라우트 없음, 잘못된 JSON 등)는 상태 코드로 오류 코드를 정하고,
 * 처리하지 못한 예외는 내부 정보 없이 500으로 응답한 뒤 서버 로그에만 남긴다.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.toResponse(exception);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): {
    status: number;
    body: ApiErrorBody;
    headers: Record<string, string>;
  } {
    if (exception instanceof ApiError) {
      return { status: exception.getStatus(), body: exception.body, headers: exception.headers };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        CODE_BY_STATUS[status] ?? (status < 500 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR');
      return {
        status,
        body: { code, message: MESSAGE_BY_CODE[code] ?? '요청을 처리하지 못했습니다' },
        headers: {},
      };
    }
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다' },
      headers: {},
    };
  }
}
