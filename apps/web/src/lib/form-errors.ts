import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { type ClientErrorCode, isApiError } from '@/lib/api';

/**
 * API 오류를 폼에 반영한다.
 * - `fieldByCode`에 있는 코드는 해당 입력 아래에 보여 준다(예: `USERNAME_TAKEN` → username).
 * - 검증 실패(`VALIDATION_FAILED`)의 필드별 원인은 같은 이름의 입력에 붙인다.
 * - 나머지는 `root` 오류(폼 위 알림)로 보여 준다.
 */
export function applyApiError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fieldByCode: Partial<Record<ClientErrorCode, Path<T>>> = {},
  fields: readonly Path<T>[] = [],
): void {
  if (!isApiError(err)) {
    setError('root', { message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요' });
    return;
  }
  const field = fieldByCode[err.code];
  if (field) {
    setError(field, { message: err.message });
    return;
  }
  if (err.code === 'VALIDATION_FAILED' && err.details?.length) {
    let matched = false;
    for (const detail of err.details) {
      const name = fields.find((f) => f === detail.path);
      if (name) {
        setError(name, { message: detail.message });
        matched = true;
      }
    }
    if (matched) return;
  }
  setError('root', { message: err.message });
}
