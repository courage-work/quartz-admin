'use client';

import type { QuartzCommand, TriggerDto } from '@qa/shared';
import { MoreHorizontalIcon, PauseIcon } from 'lucide-react';
import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { canPauseTrigger } from '@/lib/commands';

/**
 * 트리거 한 줄의 제어 메뉴. 고르면 확인 대화상자를 연다(FR-CTL-00b).
 * 읽기 전용 접속이면 항목을 끄고 이유를 메뉴 위에 적는다(FR-CTL-00a).
 */
export function TriggerActions({
  trigger,
  blockedReason,
  onCommand,
}: {
  trigger: TriggerDto;
  /** 제어할 수 없는 이유. 있으면 모든 항목을 끈다 */
  blockedReason: string | null;
  onCommand: (command: QuartzCommand, returnTo: HTMLElement | null) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const label = `${trigger.name} 트리거 제어`;
  const key = { group: trigger.group, name: trigger.name };
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button ref={button} variant="ghost" size="icon" aria-label={label}>
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {blockedReason ? (
          <>
            <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">{blockedReason}</p>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          disabled={!!blockedReason || !canPauseTrigger(trigger.state)}
          onSelect={() => onCommand({ type: 'pauseTrigger', trigger: key }, button.current)}
        >
          <PauseIcon aria-hidden />
          일시정지
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
