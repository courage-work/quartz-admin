'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * 돌아가기 링크(B-40). 화면마다 마지막으로 본 주소(필터·검색어·쪽·탭 포함)를 기억해 두고,
 * 상세 화면의 돌아가기 버튼과 경로 링크가 기본 주소 대신 그 주소로 가게 한다.
 *
 * 화면 키는 경로 + `id`(있으면)다. `/scheduler?id=3&tab=jobs&q=sync`의 키는 `/scheduler?id=3`.
 * 탭을 닫았다 열어도 이어지도록 sessionStorage에도 남긴다(못 쓰면 메모리만 쓴다).
 */

const STORAGE_KEY = 'qa.return-nav';
const MAX_ENTRIES = 50;

let lastByKey: Record<string, string> = {};
/** 지금 화면 직전의 주소. 돌아갈 곳이 바로 이전 화면이면 브라우저 뒤로 가기로 스크롤까지 되살린다 */
let previousUrl: string | null = null;
let currentUrl: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') lastByKey = parsed as Record<string, string>;
  } catch {
    // 저장소를 못 쓰면 메모리만 쓴다
  }
}

function save() {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(lastByKey));
  } catch {
    // 저장소를 못 쓰면 메모리만 쓴다
  }
}

/** 화면 키: 경로 + `id` 쿼리. 같은 상세 화면의 탭·필터는 같은 키다 */
export function screenKey(pathname: string, search: URLSearchParams): string {
  const id = search.get('id');
  return id ? `${pathname}?id=${id}` : pathname;
}

function parseHref(href: string): { pathname: string; search: URLSearchParams } {
  const url = new URL(href, 'http://local');
  return { pathname: url.pathname, search: url.searchParams };
}

function screenKeyOf(href: string): string {
  const { pathname, search } = parseHref(href);
  return screenKey(pathname, search);
}

/** 주소가 바뀔 때 부른다. 테스트에서도 쓴다 */
export function recordVisit(url: string) {
  load();
  if (url === currentUrl) return;
  const { pathname, search } = parseHref(url);
  const key = screenKey(pathname, search);
  // 같은 화면 안에서 바뀐 주소(탭·필터, history.replaceState)는 새 기록이 아니라서 직전 화면을 그대로 둔다
  if (currentUrl === null || screenKeyOf(currentUrl) !== key) previousUrl = currentUrl;
  currentUrl = url;
  delete lastByKey[key];
  lastByKey[key] = url;
  const keys = Object.keys(lastByKey);
  if (keys.length > MAX_ENTRIES)
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete lastByKey[k];
  save();
  for (const l of listeners) l();
}

/** 기본 주소 `fallback`이 가리키는 화면을 마지막으로 본 주소. 본 적이 없으면 `fallback` */
export function resolveReturnHref(fallback: string): string {
  load();
  return lastByKey[screenKeyOf(fallback)] ?? fallback;
}

/** `href`가 바로 이전 화면이면 true. 그때는 `router.back()`이 같은 곳으로 가면서 스크롤도 되살린다 */
export function isPreviousUrl(href: string): boolean {
  return previousUrl !== null && previousUrl === href;
}

/** 테스트용 초기화 */
export function resetReturnNav() {
  lastByKey = {};
  previousUrl = null;
  currentUrl = null;
  loaded = true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 레이아웃에 한 번 둔다. 주소가 바뀔 때마다 기록한다 (`useSearchParams`라 Suspense 안에 둔다) */
export function ReturnNavTracker() {
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();
  useEffect(() => {
    recordVisit(search ? `${pathname}?${search}` : pathname);
  }, [pathname, search]);
  return null;
}

/** 돌아갈 주소. 서버 렌더링(정적 export)과 첫 렌더에서는 `fallback`을 쓴다 */
export function useReturnHref(fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => resolveReturnHref(fallback),
    () => fallback,
  );
}
