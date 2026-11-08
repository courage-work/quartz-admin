/** 화면에서 나누는 목록의 한 페이지 크기 */
export const CLIENT_PAGE_SIZE = 50;

/** 전체 목록에서 `page`(1부터) 쪽을 잘라 낸다. 범위를 넘으면 마지막 쪽으로 맞춘다 */
export function paginate<T>(
  items: readonly T[],
  page: number,
  size = CLIENT_PAGE_SIZE,
): { items: T[]; page: number; total: number } {
  const last = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), last);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), page: current, total: items.length };
}

/** 검색어가 값들 중 하나에 들어 있는지(대소문자 무시). 빈 검색어는 모두 맞는다 */
export function matchesQuery(
  query: string,
  values: readonly (string | null | undefined)[],
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return values.some((v) => v?.toLowerCase().includes(q));
}
