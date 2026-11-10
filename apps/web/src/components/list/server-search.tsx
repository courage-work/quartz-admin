'use client';

import { useEffect, useState } from 'react';

import { ListSearch } from './list-search';

const SEARCH_DELAY_MS = 300;

/**
 * 서버에 묻는 목록의 검색칸(대시보드, 스케줄러의 트리거·잡 탭). 입력을 멈추면 잠시 뒤 적용하고 Enter는 바로 적용한다.
 * 화면에서 거르는 목록(접속, 사용자)의 `ListSearch`처럼 버튼 없이 입력만으로 걸러진다.
 */
export function ServerSearch({
  label,
  value,
  onApply,
}: {
  /** 검색 범위를 함께 쓴다. 예: `검색(이름·그룹·잡)` */
  label: string;
  /** 지금 적용된 검색어 */
  value: string;
  onApply: (q: string) => void;
}) {
  const [text, setText] = useState(value);
  // 바깥에서 값이 바뀌면(필터 모두 지우기) 입력칸도 맞춘다. 입력 중인 글자(끝의 공백)는 건드리지 않는다
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (value !== text.trim()) setText(value);
  }
  useEffect(() => {
    const next = text.trim();
    if (next === value) return;
    const timer = setTimeout(() => onApply(next), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, value, onApply]);
  return (
    <ListSearch
      label={label}
      value={text}
      onChange={setText}
      onSubmit={() => onApply(text.trim())}
      className="w-full max-w-md"
    />
  );
}
