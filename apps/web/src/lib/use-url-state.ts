'use client';

import { useSearchParams } from 'next/navigation';
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

/** 목록 상태 ↔ 주소 쿼리. `write`는 자기 키만 넣거나 지운다(다른 키는 건드리지 않는다) */
export interface UrlCodec<T> {
  parse(params: URLSearchParams): T;
  write(value: T, params: URLSearchParams): void;
}

/**
 * 목록 화면의 필터·검색어·쪽을 주소 쿼리에 남긴다(B-40). 상세 화면에 갔다가 뒤로 가기나
 * 돌아가기 버튼으로 오면 그대로 되살아나고, 주소를 공유해도 같은 목록이 보인다.
 *
 * 화면 상태는 컴포넌트가 들고, 바뀔 때마다 `history.replaceState`로 주소만 고친다.
 * 새 기록을 쌓지 않고(검색어 한 글자마다 뒤로 가기가 늘지 않게), 라우터 이동도 일으키지 않는다.
 * Next.js가 `replaceState`를 `useSearchParams`와 맞춰 준다.
 */
export function useUrlState<T>(codec: UrlCodec<T>): [T, Dispatch<SetStateAction<T>>] {
  const params = useSearchParams();
  const [value, setValue] = useState<T>(() => codec.parse(new URLSearchParams(params.toString())));

  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    codec.write(value, next);
    const qs = next.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`)
      window.history.replaceState(null, '', url);
    // codec은 모듈 상수로 넘긴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return [value, setValue];
}

/** 쿼리 값을 넣는다. 비었거나 기본값이면 지운다 */
export function setParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined,
  empty = '',
) {
  if (value === undefined || value === empty) params.delete(key);
  else params.set(key, value);
}

/** 쪽 번호. 1보다 작거나 숫자가 아니면 1 */
export function parsePage(raw: string | null): number {
  const n = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  return n >= 1 ? n : 1;
}
