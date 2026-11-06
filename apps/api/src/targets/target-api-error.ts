import { HttpStatus } from '@nestjs/common';
import type { TargetErrorCode } from '@qa/shared';
import type { TargetError } from '@qa/store';
import { ApiError } from '../common/api-error.js';

/** 대상 DB 오류의 HTTP 상태 (TRD §5.6) */
export const TARGET_ERROR_STATUS: Record<TargetErrorCode, HttpStatus> = {
  TARGET_UNREACHABLE: HttpStatus.BAD_GATEWAY,
  TARGET_AUTH_FAILED: HttpStatus.BAD_GATEWAY,
  TARGET_TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  TARGET_BUSY: HttpStatus.SERVICE_UNAVAILABLE,
  LOCK_TIMEOUT: HttpStatus.CONFLICT,
  TARGET_ERROR: HttpStatus.BAD_GATEWAY,
};

/** `TargetError`를 API 오류로 바꾼다. 메시지는 접속 정보가 없는 고정 문구다 */
export function targetApiError(err: TargetError): ApiError {
  return new ApiError(TARGET_ERROR_STATUS[err.code], err.code, err.message);
}
