/**
 * 열이 많은 표가 있는 화면에 둔다. 레이아웃이 본문 폭 제한을 `max-w-6xl`에서 96rem으로 넓힌다
 * (`app/(app)/layout.tsx`의 `has-data-wide-page`). 로딩·오류 때 폭이 바뀌지 않게 화면의 `page.tsx`에 둔다.
 */
export function WidePage() {
  return <span hidden data-wide-page />;
}
