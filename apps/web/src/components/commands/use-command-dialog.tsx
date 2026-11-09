'use client';

import type { QuartzCommand } from '@qa/shared';
import { type ReactNode, useState } from 'react';

import { CommandDialog } from './command-dialog';

interface DialogState {
  /** 열 때마다 늘려 대화상자 상태(오류, 충돌 안내)를 새로 시작한다 */
  seq: number;
  command: QuartzCommand;
  open: boolean;
  returnTo: HTMLElement | null;
}

/**
 * 제어 확인 대화상자를 여는 함수와 그릴 요소. 닫을 때도 마지막 명령을 남겨 두어 닫히는 효과 동안 내용이 사라지지 않게 한다.
 * @param returnTo 닫힌 뒤 포커스를 돌려줄 요소(대화상자를 연 메뉴 버튼)
 */
export function useCommandDialog(schedulerId: number): {
  openCommand: (command: QuartzCommand, returnTo?: HTMLElement | null) => void;
  dialog: ReactNode;
} {
  const [state, setState] = useState<DialogState | null>(null);
  const openCommand = (command: QuartzCommand, returnTo: HTMLElement | null = null) =>
    setState((prev) => ({ seq: (prev?.seq ?? 0) + 1, command, open: true, returnTo }));
  const dialog = state ? (
    <CommandDialog
      key={state.seq}
      schedulerId={schedulerId}
      command={state.command}
      open={state.open}
      onClose={() => setState((prev) => (prev ? { ...prev, open: false } : prev))}
      returnFocus={() => state.returnTo}
    />
  ) : null;
  return { openCommand, dialog };
}
