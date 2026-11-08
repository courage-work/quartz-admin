import type { ConnectionFormValues } from '@/lib/connections';

/**
 * 접속 폼의 임시 저장 (VectorLab defaults: 입력 중에 화면을 떠나도 값이 남게 한다).
 * 새 접속은 하나, 수정은 접속마다 따로 둔다. 비밀번호는 저장하지 않는다.
 * 저장할 수 없는 환경이면 조용히 건너뛴다.
 */
const BASE_KEY = 'qa.connectionDraft';

export type ConnectionDraft = Omit<ConnectionFormValues, 'password'>;

/**
 * 어떤 폼의 임시 저장인지. 수정은 그 접속의 마지막 수정 시각(`baseUpdatedAt`)을 함께 둬서,
 * 그 사이 다른 곳에서 접속이 바뀌었으면 옛 임시 저장을 버린다.
 */
export type DraftScope = { kind: 'new' } | { kind: 'edit'; id: number; baseUpdatedAt: number };

interface Stored {
  savedAt: number;
  values: ConnectionDraft;
  baseUpdatedAt?: number;
}

export const NEW_DRAFT: DraftScope = { kind: 'new' };

function keyOf(scope: DraftScope): string {
  return scope.kind === 'new' ? BASE_KEY : `${BASE_KEY}.${scope.id}`;
}

function read(scope: DraftScope): Stored | null {
  try {
    const raw = window.localStorage.getItem(keyOf(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (typeof parsed.savedAt !== 'number' || !parsed.values) return null;
    if (scope.kind === 'edit' && parsed.baseUpdatedAt !== scope.baseUpdatedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadConnectionDraft(scope: DraftScope = NEW_DRAFT): Stored | null {
  return read(scope);
}

/** 임시 저장 시각만. 화면 배너가 `useSyncExternalStore`로 읽으므로 원시값을 돌려준다 */
export function connectionDraftSavedAt(scope: DraftScope = NEW_DRAFT): number | null {
  return read(scope)?.savedAt ?? null;
}

export function saveConnectionDraft(
  values: ConnectionFormValues,
  scope: DraftScope = NEW_DRAFT,
  now = Date.now(),
): void {
  const { password: _password, ...rest } = values;
  void _password;
  const stored: Stored = {
    savedAt: now,
    values: rest,
    ...(scope.kind === 'edit' ? { baseUpdatedAt: scope.baseUpdatedAt } : {}),
  };
  try {
    window.localStorage.setItem(keyOf(scope), JSON.stringify(stored));
  } catch {
    // 저장 공간이 없거나 막혀 있으면 임시 저장 없이 쓴다
  }
}

export function clearConnectionDraft(scope: DraftScope = NEW_DRAFT): void {
  try {
    window.localStorage.removeItem(keyOf(scope));
  } catch {
    // 지울 수 없으면 다음 저장 때 덮어쓴다
  }
}

/** 비교 기준 값(새 접속은 빈 폼, 수정은 저장된 값)과 같으면 저장할 필요가 없다 */
export function isBlankDraft(values: ConnectionFormValues, base: ConnectionFormValues): boolean {
  return (Object.keys(base) as (keyof ConnectionFormValues)[])
    .filter((k) => k !== 'password')
    .every((k) => values[k] === base[k]);
}
