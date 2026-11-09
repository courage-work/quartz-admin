import {
  PAUSE_TRIGGER_TRANSITIONS,
  type CommandResultDto,
  type QuartzCommand,
  type SchedulerConnectionSummary,
} from '@qa/shared';

/** 확인 대화상자 제목 */
export function commandTitle(command: QuartzCommand): string {
  switch (command.type) {
    case 'pauseTrigger':
      return '트리거 일시정지';
  }
}

/** 실행 버튼 문구. 동사로 쓴다(DESIGN §10) */
export function commandConfirmLabel(command: QuartzCommand): string {
  switch (command.type) {
    case 'pauseTrigger':
      return '일시정지하기';
  }
}

/** 실행 결과 알림 (NFR-UX-03) */
export function commandResultMessage(
  result: Pick<CommandResultDto, 'command' | 'changed'>,
): string {
  const { command } = result;
  switch (command.type) {
    case 'pauseTrigger':
      return result.changed
        ? `${command.trigger.name} 트리거를 일시정지했습니다`
        : `${command.trigger.name} 트리거는 바뀐 것이 없습니다. 이미 일시정지됐거나 일시정지할 수 없는 상태입니다`;
  }
}

/** 이 상태에서 일시정지하면 바뀌는 것이 있는지 (TRD §7.3) */
export function canPauseTrigger(state: string): boolean {
  return state in PAUSE_TRIGGER_TRANSITIONS;
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
