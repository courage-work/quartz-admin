'use client';

import type { QuartzCommand } from '@qa/shared';
import { ChevronDownIcon, type LucideIcon, MoreHorizontalIcon } from 'lucide-react';
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

export interface ControlItem {
  label: string;
  icon: LucideIcon;
  command: QuartzCommand;
  /** 지금 상태에서 바뀌는 것이 없으면 끈다 */
  disabled?: boolean;
}

/**
 * 제어 메뉴. 고르면 확인 대화상자를 연다(FR-CTL-00b). 줄 끝에는 아이콘 버튼(`icon`), 화면 머리나 필터 옆에는
 * 글자 버튼(`button`)으로 둔다. 제어할 수 없는 접속이면 모든 항목을 끄고 이유를 메뉴 위에 적는다(FR-CTL-00a).
 */
export function ControlMenu({
  label,
  buttonLabel,
  blockedReason,
  items,
  onCommand,
}: {
  /** 메뉴가 무엇을 제어하는지. 아이콘 버튼이면 접근 이름과 툴팁으로 쓴다 */
  label: string;
  /** 있으면 이 글자를 보이는 버튼으로 둔다. 없으면 아이콘 버튼이다 */
  buttonLabel?: string;
  /** 제어할 수 없는 이유. 있으면 모든 항목을 끈다 */
  blockedReason: string | null;
  items: readonly ControlItem[];
  onCommand: (command: QuartzCommand, returnTo: HTMLElement | null) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const trigger = buttonLabel ? (
    <DropdownMenuTrigger asChild>
      <Button ref={button} variant="outline" aria-label={label}>
        {buttonLabel}
        <ChevronDownIcon data-icon="inline-end" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
  ) : (
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
  );
  return (
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent align="end">
        {blockedReason ? (
          <>
            <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">{blockedReason}</p>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {items.map(({ label: itemLabel, icon: Icon, command, disabled }) => (
          <DropdownMenuItem
            key={command.type}
            disabled={!!blockedReason || disabled}
            onSelect={() => onCommand(command, button.current)}
          >
            <Icon aria-hidden />
            {itemLabel}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
