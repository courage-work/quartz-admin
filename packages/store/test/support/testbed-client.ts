/** quartz-testbed `/control/*` HTTP API 클라이언트. 각 메서드는 같은 이름의 Quartz `Scheduler` 메서드를 호출한다. */

export interface KeySpec {
  name: string;
  /** 기본 `DEFAULT` */
  group?: string;
}

export type JobType = 'RecordingJob' | 'NonConcurrentSleepJob' | 'LongJob';
export type DataMap = Record<string, string | number | boolean>;

export interface JobSpec extends KeySpec {
  type: JobType;
  description?: string;
  durable?: boolean;
  requestsRecovery?: boolean;
  /** NonConcurrentSleepJob은 `sleepSeconds`, LongJob은 `durationSeconds`를 읽는다 */
  data?: DataMap;
}

interface TriggerSpecBase extends KeySpec {
  description?: string;
  priority?: number;
  /** epoch ms. 없으면 지금 */
  startAt?: number;
  endAt?: number;
  forJob?: KeySpec;
  data?: DataMap;
  /** Quartz 상수 이름. `MISFIRE_INSTRUCTION_` 접두어는 생략할 수 있다 */
  misfire?: string;
}

export interface SimpleTriggerSpec extends TriggerSpecBase {
  type?: 'simple';
  intervalMs?: number;
  /** -1은 무한 반복. intervalMs가 있으면 기본 -1, 없으면 0 */
  repeatCount?: number;
}

export interface CronTriggerSpec extends TriggerSpecBase {
  type: 'cron';
  cron: string;
  /** Java TimeZone ID */
  timeZone?: string;
}

export type TriggerSpec = SimpleTriggerSpec | CronTriggerSpec;

export type MatcherOperator = 'EQUALS' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'ANYTHING';

export interface GroupMatcherSpec {
  group?: string;
  /** 기본 EQUALS */
  operator?: MatcherOperator;
}

/** `Scheduler.getTriggerState`의 결과 */
export type TriggerState = 'NONE' | 'NORMAL' | 'PAUSED' | 'COMPLETE' | 'ERROR' | 'BLOCKED';

export interface SchedulerMetadata {
  schedulerName: string;
  instanceId: string;
  quartzVersion: string;
  started: boolean;
  standby: boolean;
  shutdown: boolean;
  clustered: boolean;
  jobStore: string;
  threadPoolSize: number;
  numberOfJobsExecuted: number;
}

export interface TriggerInfo {
  name: string;
  group: string;
  jobName: string;
  jobGroup: string;
  description: string | null;
  priority: number;
  misfireInstruction: number;
  calendarName: string | null;
  startTime: number | null;
  endTime: number | null;
  nextFireTime: number | null;
  previousFireTime: number | null;
  data: Record<string, unknown>;
  type: string;
  cron?: string;
  timeZone?: string;
  repeatCount?: number;
  intervalMs?: number;
  timesTriggered?: number;
}

export interface JobInfo {
  name: string;
  group: string;
  jobClass: string;
  description: string | null;
  durable: boolean;
  requestsRecovery: boolean;
  concurrentExecutionDisallowed: boolean;
  persistJobDataAfterExecution: boolean;
  data: Record<string, unknown>;
}

export interface ExecutingJob {
  fireInstanceId: string;
  jobName: string;
  jobGroup: string;
  triggerName: string;
  triggerGroup: string;
  fireTime: number;
}

export class TestbedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TestbedError';
  }
}

export class TestbedClient {
  constructor(readonly baseUrl: string) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await response.json()) as { result?: T; error?: string; message?: string };
    if (!response.ok) {
      throw new TestbedError(
        response.status,
        payload.error ?? 'UNKNOWN',
        `${method} ${path} 실패(${response.status}): ${payload.message ?? ''}`,
      );
    }
    return payload.result as T;
  }

  private get<T>(method: string, query: KeySpec | Record<string, never> = {}): Promise<T> {
    const params = new URLSearchParams(Object.entries(query) as [string, string][]);
    const qs = params.size ? `?${params.toString()}` : '';
    return this.request<T>('GET', `/control/${method}${qs}`);
  }

  private post<T = null>(method: string, body: object = {}): Promise<T> {
    return this.request<T>('POST', `/control/${method}`, body);
  }

  // ---- 조회 ----

  metadata(): Promise<SchedulerMetadata> {
    return this.get('metadata');
  }

  triggerState(key: KeySpec): Promise<TriggerState> {
    return this.get('triggerState', key);
  }

  trigger(key: KeySpec): Promise<TriggerInfo | null> {
    return this.get('trigger', key);
  }

  job(key: KeySpec): Promise<JobInfo | null> {
    return this.get('job', key);
  }

  pausedTriggerGroups(): Promise<string[]> {
    return this.get('pausedTriggerGroups');
  }

  /** 이 노드에서 실행 중인 잡만 돌려준다 */
  currentlyExecutingJobs(): Promise<ExecutingJob[]> {
    return this.get('currentlyExecutingJobs');
  }

  // ---- 등록 ----

  /** job과 trigger를 함께 등록한다. job 없이 `trigger.forJob`을 주면 기존 잡에 트리거를 붙인다. 결과는 첫 실행 시각 */
  scheduleJob(spec: {
    job?: JobSpec;
    trigger: TriggerSpec;
    replace?: boolean;
  }): Promise<number | null> {
    return this.post('scheduleJob', spec);
  }

  /** 트리거 없는 잡을 등록한다. Quartz 규칙상 durable이어야 한다 */
  addJob(job: JobSpec, replace = false): Promise<null> {
    return this.post('addJob', { job, replace });
  }

  // ---- 제어 ----

  pauseTrigger(key: KeySpec): Promise<null> {
    return this.post('pauseTrigger', key);
  }

  resumeTrigger(key: KeySpec): Promise<null> {
    return this.post('resumeTrigger', key);
  }

  pauseJob(key: KeySpec): Promise<null> {
    return this.post('pauseJob', key);
  }

  resumeJob(key: KeySpec): Promise<null> {
    return this.post('resumeJob', key);
  }

  pauseTriggers(matcher: GroupMatcherSpec): Promise<null> {
    return this.post('pauseTriggers', matcher);
  }

  resumeTriggers(matcher: GroupMatcherSpec): Promise<null> {
    return this.post('resumeTriggers', matcher);
  }

  pauseJobs(matcher: GroupMatcherSpec): Promise<null> {
    return this.post('pauseJobs', matcher);
  }

  resumeJobs(matcher: GroupMatcherSpec): Promise<null> {
    return this.post('resumeJobs', matcher);
  }

  pauseAll(): Promise<null> {
    return this.post('pauseAll');
  }

  resumeAll(): Promise<null> {
    return this.post('resumeAll');
  }

  /** Quartz가 `DEFAULT` 그룹에 `MT_` 접두어의 1회용 트리거를 만들어 실행한다 */
  triggerJob(key: KeySpec, data?: DataMap): Promise<null> {
    return this.post('triggerJob', { ...key, data });
  }

  /** 결과는 새 트리거의 첫 실행 시각. 기존 트리거가 없으면 null */
  rescheduleJob(key: KeySpec, trigger: TriggerSpec): Promise<number | null> {
    return this.post('rescheduleJob', { ...key, trigger });
  }

  unscheduleJob(key: KeySpec): Promise<boolean> {
    return this.post('unscheduleJob', key);
  }

  deleteJob(key: KeySpec): Promise<boolean> {
    return this.post('deleteJob', key);
  }

  /** 이 노드에서 실행 중인 잡을 interrupt한다(LongJob, NonConcurrentSleepJob) */
  interrupt(key: KeySpec): Promise<boolean> {
    return this.post('interrupt', key);
  }

  // ---- 차등 테스트 도구 (TRD §12.1) ----

  /** 문장들을 한 트랜잭션으로 실행한다(API로 만들 수 없는 초기 상태). 결과는 문장별 바뀐 행 수 */
  fixtureSql(statements: string[]): Promise<number[]> {
    return this.request('POST', '/fixture/sql', { statements });
  }

  /**
   * Quartz 잠금 행을 `seconds`초 동안 잡는다. 잡은 뒤에 돌아오며, 시간이 지나면 테스트베드가 ROLLBACK한다.
   * `schedName`을 빼면 이 노드의 SCHED_NAME이다.
   */
  holdLock(options: {
    seconds: number;
    schedName?: string;
    lockName?: string;
  }): Promise<{ waitedMs: number }> {
    return this.request('POST', '/fixture/holdLock', options);
  }

  /**
   * SCHED_NAME 하나의 Quartz 행. SCHED_NAME 컬럼은 빠져 있어 이름이 다른 두 스케줄러를 바로 비교할 수 있다.
   * `schedName`을 빼면 이 노드의 SCHED_NAME이다.
   */
  snapshot(schedName?: string): Promise<RowSnapshot> {
    const qs = schedName ? `?${new URLSearchParams({ schedName }).toString()}` : '';
    return this.request('GET', `/fixture/snapshot${qs}`);
  }
}

/** `/fixture/snapshot` 결과. 테이블별 행(컬럼 이름 대문자, JSON 문자열 순으로 정렬) */
export type RowSnapshot = Record<
  | 'TRIGGERS'
  | 'SIMPLE_TRIGGERS'
  | 'CRON_TRIGGERS'
  | 'SIMPROP_TRIGGERS'
  | 'BLOB_TRIGGERS'
  | 'PAUSED_TRIGGER_GRPS'
  | 'FIRED_TRIGGERS'
  | 'JOB_DETAILS'
  | 'LOCKS',
  Record<string, string | number | boolean | null>[]
>;
