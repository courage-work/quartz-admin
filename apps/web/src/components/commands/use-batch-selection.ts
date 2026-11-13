'use client';

import { useState } from 'react';

import { type BatchKey, batchKeyId } from '@/lib/batch';

const EMPTY: ReadonlySet<string> = new Set();

export interface BatchSelection<T extends BatchKey> {
  /** 지금 보이는 줄 중 고른 것. 보이는 순서대로 */
  selected: T[];
  isSelected: (row: BatchKey) => boolean;
  toggle: (row: BatchKey) => void;
  /** 머리 칸 체크박스 상태 */
  all: boolean | 'indeterminate';
  toggleAll: () => void;
  clear: () => void;
}

/**
 * 목록에서 일괄 제어할 줄 고르기 (FR-CTL-10). 지금 보이는 쪽 안에서만 고른다.
 * `scope`(필터·정렬·쪽)가 바뀌면 고른 것을 비운다. 다시 읽어 사라진 줄은 고른 것에서 빠진다.
 */
export function useBatchSelection<T extends BatchKey>(
  scope: string,
  rows: readonly T[] | undefined,
): BatchSelection<T> {
  const [state, setState] = useState<{ scope: string; ids: ReadonlySet<string> }>({
    scope,
    ids: EMPTY,
  });
  const ids = state.scope === scope ? state.ids : EMPTY;
  const visible = rows ?? [];
  const selected = visible.filter((r) => ids.has(batchKeyId(r)));
  const update = (fn: (ids: Set<string>) => void) =>
    setState((prev) => {
      const next = new Set(prev.scope === scope ? prev.ids : EMPTY);
      fn(next);
      return { scope, ids: next };
    });
  return {
    selected,
    isSelected: (row) => ids.has(batchKeyId(row)),
    toggle: (row) =>
      update((next) => {
        const id = batchKeyId(row);
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }),
    all:
      selected.length === 0 ? false : selected.length === visible.length ? true : 'indeterminate',
    toggleAll: () =>
      update((next) => {
        const allSelected = visible.length > 0 && selected.length === visible.length;
        next.clear();
        if (!allSelected) for (const r of visible) next.add(batchKeyId(r));
      }),
    clear: () => setState({ scope, ids: EMPTY }),
  };
}
