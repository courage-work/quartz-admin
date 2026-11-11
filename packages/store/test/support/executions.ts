import type { TestConnection } from './db.js';
import { waitFor, type WaitOptions } from './wait.js';

/** 테스트베드 잡이 `TESTBED_EXECUTIONS`에 남긴 실행 기록 한 건 */
export interface ExecutionRecord {
  fireInstanceId: string;
  schedName: string;
  instanceId: string;
  jobName: string;
  jobGroup: string;
  jobClass: string;
  triggerName: string;
  triggerGroup: string;
  scheduledFireTime: number | null;
  fireTime: number;
  startedAt: number;
  finishedAt: number | null;
  /** RUNNING, OK, INTERRUPTED, ERROR */
  outcome: string;
  recovering: boolean;
  refireCount: number;
  /** 잡과 트리거의 JobDataMap을 합친 값 */
  jobData: Record<string, unknown>;
}

export interface ExecutionFilter {
  schedName?: string;
  instanceId?: string;
  jobName?: string;
  jobGroup?: string;
  triggerName?: string;
  triggerGroup?: string;
  outcome?: string;
  /** 기본 `TESTBED_EXECUTIONS` */
  table?: string;
}

interface Row {
  FIRE_INSTANCE_ID: string;
  SCHED_NAME: string;
  INSTANCE_ID: string;
  JOB_NAME: string;
  JOB_GROUP: string;
  JOB_CLASS: string;
  TRIGGER_NAME: string;
  TRIGGER_GROUP: string;
  SCHEDULED_FIRE_TIME: number | null;
  FIRE_TIME: number;
  STARTED_AT: number;
  FINISHED_AT: number | null;
  OUTCOME: string;
  RECOVERING: string;
  REFIRE_COUNT: number;
  JOB_DATA: string | null;
}

const COLUMNS: Record<Exclude<keyof ExecutionFilter, 'table'>, string> = {
  schedName: 'SCHED_NAME',
  instanceId: 'INSTANCE_ID',
  jobName: 'JOB_NAME',
  jobGroup: 'JOB_GROUP',
  triggerName: 'TRIGGER_NAME',
  triggerGroup: 'TRIGGER_GROUP',
  outcome: 'OUTCOME',
};

function tableName(filter: ExecutionFilter): string {
  const table = filter.table ?? 'TESTBED_EXECUTIONS';
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(table)) {
    throw new Error(`테이블 이름으로 쓸 수 없는 값입니다: ${table}`);
  }
  return table;
}

function where(filter: ExecutionFilter): { sql: string; binds: Record<string, string> } {
  const conditions: string[] = [];
  const binds: Record<string, string> = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = filter[key as keyof typeof COLUMNS];
    if (value !== undefined) {
      conditions.push(`${column} = :${key}`);
      binds[key] = value;
    }
  }
  return { sql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', binds };
}

function toRecord(row: Row): ExecutionRecord {
  return {
    fireInstanceId: row.FIRE_INSTANCE_ID,
    schedName: row.SCHED_NAME,
    instanceId: row.INSTANCE_ID,
    jobName: row.JOB_NAME,
    jobGroup: row.JOB_GROUP,
    jobClass: row.JOB_CLASS,
    triggerName: row.TRIGGER_NAME,
    triggerGroup: row.TRIGGER_GROUP,
    scheduledFireTime: row.SCHEDULED_FIRE_TIME,
    fireTime: row.FIRE_TIME,
    startedAt: row.STARTED_AT,
    finishedAt: row.FINISHED_AT,
    outcome: row.OUTCOME,
    recovering: row.RECOVERING === '1',
    refireCount: row.REFIRE_COUNT,
    jobData: row.JOB_DATA ? (JSON.parse(row.JOB_DATA) as Record<string, unknown>) : {},
  };
}

/** 조건에 맞는 실행 기록을 시작 시각 순으로 돌려준다 */
export async function listExecutions(
  conn: TestConnection,
  filter: ExecutionFilter = {},
): Promise<ExecutionRecord[]> {
  const { sql, binds } = where(filter);
  const result = await conn.execute<Row>(
    `SELECT * FROM ${tableName(filter)}${sql} ORDER BY STARTED_AT, FIRE_INSTANCE_ID`,
    binds,
    { outFormat: 'object' },
  );
  return (result.rows ?? []).map(toRecord);
}

export interface WaitForExecutionsOptions extends WaitOptions {
  /** 기다릴 최소 건수. 기본 1 */
  min?: number;
}

/** 실행 기록이 `min`건 이상 쌓일 때까지 기다린다. */
export function waitForExecutions(
  conn: TestConnection,
  filter: ExecutionFilter,
  options: WaitForExecutionsOptions = {},
): Promise<ExecutionRecord[]> {
  const min = options.min ?? 1;
  return waitFor(
    async () => {
      const records = await listExecutions(conn, filter);
      return records.length >= min ? records : null;
    },
    { message: `실행 기록 ${min}건(${JSON.stringify(filter)})`, ...options },
  );
}

/** 조건에 맞는 실행 기록을 지운다. */
export async function clearExecutions(
  conn: TestConnection,
  filter: ExecutionFilter = {},
): Promise<number> {
  const { sql, binds } = where(filter);
  const result = await conn.execute(`DELETE FROM ${tableName(filter)}${sql}`, binds);
  await conn.commit();
  return result.rowsAffected ?? 0;
}
