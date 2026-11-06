export const LOGIN_PATH = '/login';

/**
 * 로그인 후 돌아갈 경로. 같은 오리진의 경로만 허용한다(오픈 리다이렉트 방지).
 * `//evil.com`, `/\evil.com`, `https://…`, 로그인 화면 자신은 홈으로 바꾼다.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if ([...next].some((c) => c.charCodeAt(0) < 0x20)) return '/';
  const pathname = next.split(/[?#]/)[0] ?? '';
  if (pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`) return '/';
  return next;
}

/** 지금 보던 화면으로 돌아오도록 `next`를 붙인 로그인 경로 */
export function loginHref(pathname: string, search = ''): string {
  const current = `${pathname}${search}`;
  const next = safeNextPath(current);
  return next === '/' ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

/** `?id=` 값. 양의 정수가 아니면 null (정적 export라 상세 화면 ID를 쿼리로 받는다, TRD §2.2) */
export function parseId(raw: string | null): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  return Number(raw);
}
