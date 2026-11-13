'use client';

import type { PausedGroupsResponse } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { PauseIcon, PlayIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { schedulerViewKey } from '@/lib/schedulers';

import { ControlMenu } from './control-menu';
import { useCommandDialog } from './use-command-dialog';

/**
 * 일시정지된 트리거 그룹과 전체 일시정지 여부. 일시정지 그룹 탭과 같은 조회 키를 써서 한 번만 읽는다.
 * 대상 DB에 연결할 수 없으면 읽지 않는다.
 */
function usePausedGroups(schedulerId: number, refreshMs: number, enabled: boolean) {
  return useQuery({
    queryKey: schedulerViewKey(schedulerId, 'paused'),
    queryFn: ({ signal }) =>
      api<PausedGroupsResponse>(`/schedulers/${schedulerId}/paused-groups`, { signal }),
    enabled,
    refetchInterval: refreshMs || false,
    placeholderData: (prev) => prev,
  });
}

/** 스케줄러 머리글의 "전체 일시정지" 배지 (FR-CTL-11). 전체 일시정지 상태일 때만 보인다 */
export function PauseAllBadge({
  schedulerId,
  refreshMs,
  enabled,
}: {
  schedulerId: number;
  refreshMs: number;
  enabled: boolean;
}) {
  const paused = usePausedGroups(schedulerId, refreshMs, enabled);
  if (!enabled || !paused.data?.allPaused) return null;
  return (
    <Badge variant="warning">
      <PauseIcon aria-hidden />
      전체 일시정지
    </Badge>
  );
}

/**
 * 스케줄러 전체 일시정지·재개 메뉴 (FR-CTL-11). 고르면 확인 대화상자가 영향 범위를 보여 주고,
 * 스케줄러 이름을 입력해야 실행한다. 제어할 수 없는 접속이면 항목을 끄고 이유를 보여 준다.
 */
export function SchedulerControlMenu({
  schedulerId,
  blockedReason,
}: {
  schedulerId: number;
  blockedReason: string | null;
}) {
  const { openCommand, dialog } = useCommandDialog(schedulerId);
  return (
    <>
      <ControlMenu
        label="스케줄러 전체 제어"
        buttonLabel="전체 제어"
        blockedReason={blockedReason}
        items={[
          { label: '전체 일시정지', icon: PauseIcon, command: { type: 'pauseAll' } },
          { label: '전체 재개', icon: PlayIcon, command: { type: 'resumeAll' } },
        ]}
        onCommand={openCommand}
      />
      {dialog}
    </>
  );
}
