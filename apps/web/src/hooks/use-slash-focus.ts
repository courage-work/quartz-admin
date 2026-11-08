import { type RefObject, useEffect } from 'react';

/** 입력 중인 곳에서 `/`를 누른 경우는 단축키로 보지 않는다 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * 화면 어디서든 `/`를 누르면 검색칸으로 포커스를 옮긴다 (VectorLab keyboard, list 패턴).
 * 입력 중이거나 수정 키(Ctrl·Alt·Meta)를 함께 누른 경우, 대화상자가 열린 경우는 건너뛴다.
 */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (!ref.current) return;
      e.preventDefault();
      ref.current.focus();
      ref.current.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ref]);
}
