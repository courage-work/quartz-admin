export type TriggerSpecErrorCode =
  | 'END_BEFORE_START'
  | 'NEGATIVE_REPEAT_COUNT'
  | 'NEGATIVE_REPEAT_INTERVAL'
  | 'ZERO_REPEAT_INTERVAL';

/** Quartz가 트리거를 만들 때 거부하는 값 (`setEndTime`, `setRepeatCount`, `validate` 등) */
export class TriggerSpecError extends Error {
  constructor(
    readonly code: TriggerSpecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TriggerSpecError';
  }
}
