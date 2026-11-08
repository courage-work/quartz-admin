import { describe, expect, it } from 'vitest';

import { matchesQuery, paginate } from './paging';

describe('paginate', () => {
  const items = Array.from({ length: 120 }, (_, i) => i);

  it('요청한 쪽을 잘라 낸다', () => {
    expect(paginate(items, 2, 50)).toEqual({ items: items.slice(50, 100), page: 2, total: 120 });
  });

  it('범위를 넘는 쪽은 마지막 쪽으로 맞춘다', () => {
    expect(paginate(items, 9, 50).page).toBe(3);
    expect(paginate(items, 0, 50).page).toBe(1);
  });

  it('빈 목록도 1쪽이다', () => {
    expect(paginate([], 3)).toEqual({ items: [], page: 1, total: 0 });
  });
});

describe('matchesQuery', () => {
  it('대소문자를 무시하고 부분 일치한다', () => {
    expect(matchesQuery('BILL', ['결제', 'billing'])).toBe(true);
    expect(matchesQuery('report', ['billing', null])).toBe(false);
  });

  it('빈 검색어는 모두 맞는다', () => {
    expect(matchesQuery('  ', [null])).toBe(true);
  });
});
