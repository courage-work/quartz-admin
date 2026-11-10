import {
  commandScope,
  PAUSE_TRIGGER_TRANSITIONS,
  RESUMABLE_TRIGGER_STATES,
  type CommandChangeDto,
  type CommandResultDto,
  type QuartzCommand,
  type SchedulerConnectionSummary,
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
  }
}

const isPause = (command: QuartzCommand) => command.type.startsWith('pause');

/** 실행 버튼 문구. 동사로 쓴다(DESIGN §10) */
export function commandConfirmLabel(command: QuartzCommand): string {
  return isPause(command) ? '일시정지하기' : '재개하기';
}

/** 명령 대상을 사람이 읽는 말로. 확인 대화상자의 대상 줄과 결과 알림에 쓴다 */
export function commandSubject(command: QuartzCommand): string {
  switch (command.type) {
    case 'pauseTrigger':
    case 'resumeTrigger':
      return `${command.trigger.name} 트리거`;
    case 'pauseJob':
    case 'resumeJob':
      return `${command.job.name} 잡`;
    case 'pauseTriggerGroup':
    case 'resumeTriggerGroup':
      return `${command.group} 트리거 그룹`;
    case 'pauseJobGroup':
    case 'resumeJobGroup':
      return `${command.group} 잡 그룹`;
  }
}

/** 실행 결과 알림 (NFR-UX-03). 재개한 트리거 중 실행 시각이 지난 것이 있으면 misfire 처리 안내를 붙인다 */
export function commandResultMessage(
  result: Pick<CommandResultDto, 'command' | 'changed'> &
    Partial<Pick<CommandResultDto, 'warnings'>>,
): string {
  const { command } = result;
  const subject = commandSubject(command);
  // 대상 말이 "트리거"로 끝나면 받침이 없고, "잡", "그룹"으로 끝나면 받침이 있다
  const vowel = commandScope(command) === 'trigger';
  const topic = `${subject}${vowel ? '는' : '은'}`;
  const object = `${subject}${vowel ? '를' : '을'}`;
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
