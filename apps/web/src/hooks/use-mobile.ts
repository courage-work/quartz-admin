import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/**
 * 화면 폭이 모바일 기준보다 좁은지. shadcn 원본은 effect 안에서 setState를 불러
 * react-hooks 린트에 걸리므로 `useSyncExternalStore`로 바꿨다. 정적 HTML 생성 시에는 데스크톱으로 본다.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
