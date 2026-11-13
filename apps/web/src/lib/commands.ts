import {
  commandScope,
  PAUSE_TRIGGER_TRANSITIONS,
  RESUMABLE_TRIGGER_STATES,
  type CommandChangeDto,
  type CommandResultDto,
  type QuartzCommand,
  type SchedulerConnectionSummary,
  type TriggerDto,
} from '@qa/shared';

/** 확인 대화상자 제목 */
export function commandTitle(command: QuartzCommand): string {
  switch (command.type) {
    case 'pauseTrigger':
      return '트리거 일시정지';
    case 'resumeTrigger':
      return '트리거 재개';
    case 'pauseJob':
      return '잡 일시정지';
    case 'resumeJob':
      return '잡 재개';
    case 'pauseTriggerGroup':
      return '트리거 그룹 일시정지';
    case 'resumeTriggerGroup':
      return '트리거 그룹 재개';
    case 'pauseJobGroup':
      return '잡 그룹 일시정지';
    case 'resumeJobGroup':
      return '잡 그룹 재개';
    case 'pauseAll':
      return '스케줄러 전체 일시정지';
    case 'resumeAll':
      return '스케줄러 전체 재개';
    case 'triggerJob':
      return '잡 즉시 실행';
    case 'updateCronSchedule':
      return 'CRON 스케줄 수정';
    case 'updateSimpleSchedule':
      return 'SIMPLE 스케줄 수정';
    // 지우는 명령은 대상 이름을 쓴 질문으로 묻는다(DESIGN §8.1.3)
    case 'deleteTrigger':
      return `${command.trigger.name} 트리거를 삭제할까요?`;
    case 'deleteJob':
      return `${command.job.name} 잡을 삭제할까요?`;
  }
}

/** 되돌릴 수 없는 명령인지. 확인 버튼과 메뉴 항목을 destructive 모양으로 그린다 */
export function isDestructive(command: QuartzCommand): boolean {
  return command.type === 'deleteTrigger' || command.type === 'deleteJob';
}

const isPause = (command: QuartzCommand) => command.type.startsWith('pause');

/** 실행 버튼 문구. 동사로 쓴다(DESIGN §10) */
export function commandConfirmLabel(command: QuartzCommand): string {
  if (command.type === 'triggerJob') return '실행하기';
  if (command.type === 'deleteTrigger') return `${command.trigger.name} 삭제하기`;
  if (command.type === 'deleteJob') return `${command.job.name} 삭제하기`;
  if (command.type === 'updateCronSchedule' || command.type === 'updateSimpleSchedule') {
    return '수정하기';
  }
  if (command.type === 'pauseAll') return '전체 일시정지하기';
  if (command.type === 'resumeAll') return '전체 재개하기';
  return isPause(command) ? '일시정지하기' : '재개하기';
}

/** 명령 대상을 사람이 읽는 말로. 확인 대화상자의 대상 줄과 결과 알림에 쓴다 */
export function commandSubject(command: QuartzCommand): string {
  switch (command.type) {
    case 'pauseTrigger':
    case 'resumeTrigger':
    case 'updateCronSchedule':
    case 'updateSimpleSchedule':
    case 'deleteTrigger':
      return `${command.trigger.name} 트리거`;
    case 'pauseJob':
    case 'resumeJob':
    case 'triggerJob':
    case 'deleteJob':
      return `${command.job.name} 잡`;
    case 'pauseTriggerGroup':
    case 'resumeTriggerGroup':
      return `${command.group} 트리거 그룹`;
    case 'pauseJobGroup':
    case 'resumeJobGroup':
      return `${command.group} 잡 그룹`;
    case 'pauseAll':
    case 'resumeAll':
      return '스케줄러 전체';
  }
}

/** 실행 결과 알림 (NFR-UX-03). 재개한 트리거 중 실행 시각이 지난 것이 있으면 misfire 처리 안내를 붙인다 */
export function commandResultMessage(
  result: Pick<CommandResultDto, 'command' | 'changed'> &
    Partial<Pick<CommandResultDto, 'warnings' | 'inserts' | 'deletions'>>,
): string {
  const { command } = result;
  const subject = commandSubject(command);
  // 대상 말이 "트리거", "전체"로 끝나면 받침이 없고, "잡", "그룹"으로 끝나면 받침이 있다
  const vowel = commandScope(command) === 'trigger' || commandScope(command) === 'scheduler';
  const topic = `${subject}${vowel ? '는' : '은'}`;
  const object = `${subject}${vowel ? '를' : '을'}`;
  if (command.type === 'triggerJob') return triggerJobMessage(object, result.inserts?.[0]?.state);
  if (command.type === 'deleteTrigger') {
    return (result.deletions?.jobs.length ?? 0) > 0
      ? `${object} 삭제했습니다. durable이 아닌 잡이라 잡도 함께 삭제했습니다`
      : `${object} 삭제했습니다`;
  }
  if (command.type === 'deleteJob') {
    const count = result.deletions?.triggers.length ?? 0;
    return count > 0 ? `${object} 트리거 ${count}개와 함께 삭제했습니다` : `${object} 삭제했습니다`;
  }
  if (command.type === 'updateCronSchedule' || command.type === 'updateSimpleSchedule') {
    const kept = result.warnings?.some((w) => w.code === 'PAUSE_KEPT');
    return kept
      ? `${subject}의 스케줄을 수정했습니다. 일시정지 상태는 그대로입니다`
      : `${subject}의 스케줄을 수정했습니다`;
  }
  if (!result.changed) {
    return isPause(command)
      ? `${topic} 바뀐 것이 없습니다. 이미 일시정지됐거나 일시정지할 수 없는 상태입니다`
      : `${topic} 바뀐 것이 없습니다. 일시정지된 트리거가 없습니다`;
  }
  if (isPause(command)) return `${object} 일시정지했습니다`;
  const misfire = result.warnings?.some((w) => w.code === 'MISFIRE_DELEGATED');
  return misfire
    ? `${object} 재개했습니다. 지난 실행은 Quartz 노드가 misfire 정책에 따라 최대 1분(misfireThreshold) 안에 처리합니다`
    : `${object} 재개했습니다`;
}

/** 즉시 실행 결과. 넣은 트리거의 상태에 따라 언제 실행되는지 알린다 (TRD §7.5) */
function triggerJobMessage(object: string, state: string | undefined): string {
  switch (state) {
    case 'BLOCKED':
      return `${object} 즉시 실행으로 걸었습니다. 지금 실행 중인 잡이 끝난 뒤에 실행됩니다`;
    case 'PAUSED':
    case 'PAUSED_BLOCKED':
      return `${object} 즉시 실행으로 걸었지만 그룹이 일시정지 상태라 재개해야 실행됩니다`;
    default:
      // 도구는 노드를 깨울 수 없어 노드가 다음 획득 주기에 집는다(TRD §7.5)
      return `${object} 즉시 실행으로 걸었습니다. Quartz 노드가 다음 확인 때(기본 최대 30초) 실행합니다`;
  }
}

/**
 * 스케줄을 수정할 수 없는 이유 (TRD §7.6). 서버도 같은 기준으로 다시 거부한다.
 * CRON과 SIMPLE 트리거만 고칠 수 있고, 캘린더가 연결됐거나 COMPLETE면 안 된다
 */
export function rescheduleBlockedReason(
  trigger: Pick<TriggerDto, 'type' | 'state' | 'calendarName' | 'cron' | 'simple'>,
): string | null {
  if (trigger.state === 'COMPLETE') return '실행을 마쳐 곧 삭제될 트리거입니다';
  if (trigger.calendarName) return '캘린더가 연결된 트리거는 수정할 수 없습니다';
  if (
    !(trigger.type === 'CRON' && trigger.cron) &&
    !(trigger.type === 'SIMPLE' && trigger.simple)
  ) {
    return 'CRON, SIMPLE 트리거만 수정할 수 있습니다';
  }
  return null;
}

/** 스케줄 수정 화면 주소. `from=job`이면 저장·취소 뒤 잡 상세로 돌아간다 */
export function rescheduleHref(
  schedulerId: number,
  trigger: { group: string; name: string },
  from?: { job: { group: string; name: string } },
): string {
  const q = new URLSearchParams({
    scheduler: String(schedulerId),
    group: trigger.group,
    name: trigger.name,
  });
  if (from) {
    q.set('from', 'job');
    q.set('jobGroup', from.job.group);
    q.set('jobName', from.job.name);
  }
  return `/trigger/schedule?${q.toString()}`;
}

/** 이 상태에서 일시정지하면 바뀌는 것이 있는지 (TRD §7.3) */
export function canPauseTrigger(state: string): boolean {
  return state in PAUSE_TRIGGER_TRANSITIONS;
}

/** 이 상태에서 재개할 수 있는지 (TRD §7.3). 다음 실행 시각이 없으면 서버가 "변경 없음"으로 알린다 */
export function canResumeTrigger(state: string): boolean {
  return (RESUMABLE_TRIGGER_STATES as readonly string[]).includes(state);
}

/** 상태 변경을 바꾸기 전·후 상태로 묶어 센다. 그룹 명령은 트리거가 많아 하나씩 적지 않는다 */
export function summarizeChanges(
  changes: readonly CommandChangeDto[],
): { from: string; to: string; count: number }[] {
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const c of changes) {
    const key = `${c.from}\u0000${c.to}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { from: c.from, to: c.to, count: 1 });
  }
  return [...counts.values()];
}

/**
 * 제어 버튼을 끌 이유 (FR-CTL-00a). 화면에서 미리 끄는 용도이고, 서버도 같은 기준으로 다시 거부한다.
 * 문구는 서버의 미리보기 차단 사유와 같은 뜻으로 짧게 쓴다.
 */
export function controlBlockedReason(
  connection: Pick<SchedulerConnectionSummary, 'readOnly' | 'writeCapable'>,
): string | null {
  if (connection.readOnly) return '읽기 전용 접속이라 제어할 수 없습니다';
  if (connection.writeCapable === false) return '접속 계정에 쓰기 권한이 없어 제어할 수 없습니다';
  if (connection.writeCapable === null) return '쓰기 권한을 확인하지 않아 제어할 수 없습니다';
  return null;
}
