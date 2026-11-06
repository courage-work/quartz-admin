import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './api-error.js';

/**
 * 요청 본문을 `@qa/shared`의 zod 스키마로 검증한다.
 * nestjs-zod는 아직 NestJS 12를 지원하지 않아(peer `^10 || ^11`) 직접 둔다.
 *
 * @example `@Body(new ZodPipe(loginRequestSchema)) body: LoginRequest`
 */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_FAILED',
      '입력값이 올바르지 않습니다',
      // 입력값 자체는 돌려주지 않는다(비밀번호가 들어 있을 수 있음)
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
}
