import type { ConnectionFormValues } from '@/lib/connections';

/**
 * 새 접속 폼의 임시 저장. 입력 중에 화면을 떠나도 값이 남게 한다.
 * 비밀번호는 저장하지 않는다. 저장할 수 없는 환경이면 조용히 건너뛴다.
 */
const KEY = 'qa.connectionDraft';

export type ConnectionDraft = Omit<ConnectionFormValues, 'password'>;

interface Stored {
  savedAt: number;
  values: ConnectionDraft;
}

function read(): Stored | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    return typeof parsed.savedAt === 'number' && parsed.values ? parsed : null;
  } catch {
    return null;
  }
}

export function loadConnectionDraft(): Stored | null {
  return read();
}

/** 임시 저장 시각만. 화면 배너가 `useSyncExternalStore`로 읽으므로 원시값을 돌려준다 */
export function connectionDraftSavedAt(): number | null {
  return read()?.savedAt ?? null;
}

export function saveConnectionDraft(values: ConnectionFormValues, now = Date.now()): void {
  const { password: _password, ...rest } = values;
  void _password;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: now, values: rest } satisfies Stored),
    );
  } catch {
    // 저장 공간이 없거나 막혀 있으면 임시 저장 없이 쓴다
  }
}

export function clearConnectionDraft(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // 지울 수 없으면 다음 저장 때 덮어쓴다
  }
}

/** 기본값과 같으면 저장할 필요가 없다 */
export function isBlankDraft(values: ConnectionFormValues, empty: ConnectionFormValues): boolean {
  return (Object.keys(empty) as (keyof ConnectionFormValues)[])
    .filter((k) => k !== 'password')
    .every((k) => values[k] === empty[k]);
}
