/** QRTZ_TRIGGERS.TRIGGER_STATE 값 (Quartz 2.x `org.quartz.impl.jdbcjobstore.Constants`) */
export const TRIGGER_STATES = [
  'WAITING',
  'ACQUIRED',
  'EXECUTING',
  'COMPLETE',
  'BLOCKED',
  'ERROR',
  'PAUSED',
  'PAUSED_BLOCKED',
  'DELETED',
] as const;

export type TriggerState = (typeof TRIGGER_STATES)[number];

export function isTriggerState(value: unknown): value is TriggerState {
  return typeof value === 'string' && (TRIGGER_STATES as readonly string[]).includes(value);
}
