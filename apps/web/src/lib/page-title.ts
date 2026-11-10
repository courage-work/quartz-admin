import { APP_NAME } from '@qa/shared';
import { useEffect } from 'react';

/**
 * 상세 화면의 브라우저 탭 제목을 대상 이름으로 바꾼다. 정적 export라 `metadata`의 제목은 "스케줄러"처럼
 * 화면 종류뿐이어서, 여러 탭을 열면 구분되지 않는다. 이름을 아직 모르면(로딩, 없는 주소) 그대로 둔다.
 *
 * 이름을 이미 알고 화면을 열면(캐시) Next가 뒤이어 `metadata` 제목으로 덮어쓰므로, 이 화면에 있는 동안
 * 제목이 바뀌면 다시 맞춘다. 다른 화면으로 넘어간 뒤에는(경로가 달라지면) 손대지 않는다.
 */
export function usePageTitle(name: string | null | undefined): void {
  useEffect(() => {
    if (!name) return;
    const title = `${name} · ${APP_NAME}`;
    const pathname = window.location.pathname;
    const apply = () => {
      if (window.location.pathname === pathname && document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [name]);
}
