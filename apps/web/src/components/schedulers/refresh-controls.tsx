'use client';

import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format';
import {
  DEFAULT_REFRESH_MS,
  loadRefreshMs,
  REFRESH_INTERVALS,
  saveRefreshMs,
} from '@/lib/schedulers';

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/**
 * 자동 새로고침 주기. 화면을 옮겨도 같은 값을 쓰도록 브라우저에 저장한다 (FR-VIEW-06).
 * 정적 export의 빌드 시 렌더와 첫 하이드레이션은 기본값을 쓰고, 그 뒤 저장값을 읽는다.
 */
export function useRefreshInterval(): [number, (ms: number) => void] {
  const ms = useSyncExternalStore(subscribe, loadRefreshMs, () => DEFAULT_REFRESH_MS);
  return [
    ms,
    (next) => {
      saveRefreshMs(next);
      for (const l of listeners) l();
    },
  ];
}

/** 100ms 넘게 이어질 때만 true. 금방 끝나는 새로고침에 스피너가 깜빡이지 않게 한다 */
function useDelayedFlag(flag: boolean, delayMs = 100): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(flag), flag ? delayMs : 0);
    return () => clearTimeout(timer);
  }, [flag, delayMs]);
  return flag && shown;
}

/** 데이터 기준 시각, 자동 새로고침 주기, 수동 새로고침 버튼 */
export function RefreshControls({
  dataTime,
  dataTimeLabel = '데이터 기준',
  refreshMs,
  onRefreshMsChange,
  onRefresh,
  refreshing,
}: {
  dataTime: number | null | undefined;
  dataTimeLabel?: string;
  refreshMs: number;
  onRefreshMsChange: (ms: number) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const busy = useDelayedFlag(refreshing);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">
        {dataTimeLabel} {formatDateTime(dataTime)}
      </span>
      <Select value={String(refreshMs)} onValueChange={(v) => onRefreshMsChange(Number(v))}>
        <SelectTrigger aria-label="자동 새로고침 주기" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REFRESH_INTERVALS.map((o) => (
            <SelectItem key={o.value} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" onClick={onRefresh} aria-busy={busy}>
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RefreshCwIcon data-icon="inline-start" aria-hidden />
        )}
        새로고침
      </Button>
    </div>
  );
}
