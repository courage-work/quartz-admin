'use client';

import type { QuartzCommand, TriggerDto } from '@qa/shared';
import { CalendarClockIcon, PauseIcon, PlayIcon, ZapIcon } from 'lucide-react';

import { ControlMenu } from '@/components/commands/control-menu';
import {
  canPauseTrigger,
  canResumeTrigger,
  rescheduleBlockedReason,
  rescheduleHref,
} from '@/lib/commands';

type OnCommand = (command: QuartzCommand, returnTo: HTMLElement | null) => void;

/**
 * 트리거 한 줄의 제어 메뉴. 지금 상태에서 바뀌는 것이 없는 항목은 끈다.
 * 스케줄 수정은 입력이 길어 확인 대화상자 대신 수정 화면으로 간다(DESIGN §8 오버레이 선택).
 */
export function TriggerActions({
  schedulerId,
  trigger,
  blockedReason,
  onCommand,
  fromJob,
}: {
  schedulerId: number;
  trigger: TriggerDto;
  /** 제어할 수 없는 이유. 있으면 모든 항목을 끈다 */
  blockedReason: string | null;
  onCommand: OnCommand;
  /** 잡 상세에서 열었으면 스케줄 수정 뒤 잡 상세로 돌아온다 */
  fromJob?: boolean;
}) {
  const key = { group: trigger.group, name: trigger.name };
  return (
    <ControlMenu
      label={`${trigger.name} 트리거 제어`}
      blockedReason={blockedReason}
      onCommand={onCommand}
      items={[
        {
          label: '일시정지',
          icon: PauseIcon,
          command: { type: 'pauseTrigger', trigger: key },
          disabled: !canPauseTrigger(trigger.state),
        },
        {
          label: '재개',
          icon: PlayIcon,
          command: { type: 'resumeTrigger', trigger: key },
          disabled: !canResumeTrigger(trigger.state),
        },
        {
          label: '스케줄 수정',
          icon: CalendarClockIcon,
          href: rescheduleHref(
            schedulerId,
            key,
            fromJob ? { job: { group: trigger.jobGroup, name: trigger.jobName } } : undefined,
          ),
          disabled: rescheduleBlockedReason(trigger) !== null,
        },
      ]}
    />
  );
}

/**
 * 잡의 제어 메뉴(잡의 모든 트리거의 일시정지·재개, 즉시 실행). 잡 목록에는 트리거 상태가 없어 항목을 미리 끄지 않고,
 * 바뀌는 것이 없으면 확인 대화상자가 알려 준다
 */
export function JobActions({
  job,
  blockedReason,
  onCommand,
  buttonLabel,
}: {
  job: { group: string; name: string };
  blockedReason: string | null;
  onCommand: OnCommand;
  /** 있으면 글자 버튼으로 둔다(잡 상세 머리) */
  buttonLabel?: string;
}) {
  const key = { group: job.group, name: job.name };
  return (
    <ControlMenu
      label={`${job.name} 잡 제어`}
      buttonLabel={buttonLabel}
      blockedReason={blockedReason}
      onCommand={onCommand}
      items={[
        { label: '잡 일시정지', icon: PauseIcon, command: { type: 'pauseJob', job: key } },
        { label: '잡 재개', icon: PlayIcon, command: { type: 'resumeJob', job: key } },
        { label: '즉시 실행', icon: ZapIcon, command: { type: 'triggerJob', job: key } },
      ]}
    />
  );
}

/** 필터로 고른 그룹 하나의 제어 메뉴. 트리거 그룹(트리거 탭)과 잡 그룹(잡 탭)에 쓴다 */
export function GroupActions({
  kind,
  group,
  blockedReason,
  onCommand,
}: {
  kind: 'trigger' | 'job';
  group: string;
  blockedReason: string | null;
  onCommand: OnCommand;
}) {
  const noun = kind === 'trigger' ? '트리거 그룹' : '잡 그룹';
  return (
    <ControlMenu
      label={`${group} ${noun} 제어`}
      buttonLabel="그룹 제어"
      blockedReason={blockedReason}
      onCommand={onCommand}
      items={
        kind === 'trigger'
          ? [
              {
                label: `${noun} 일시정지`,
                icon: PauseIcon,
                command: { type: 'pauseTriggerGroup', group },
              },
              {
                label: `${noun} 재개`,
                icon: PlayIcon,
                command: { type: 'resumeTriggerGroup', group },
              },
            ]
          : [
              {
                label: `${noun} 일시정지`,
                icon: PauseIcon,
                command: { type: 'pauseJobGroup', group },
              },
              { label: `${noun} 재개`, icon: PlayIcon, command: { type: 'resumeJobGroup', group } },
            ]
      }
    />
  );
}
