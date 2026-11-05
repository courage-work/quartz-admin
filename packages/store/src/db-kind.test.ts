import { describe, expect, it } from 'vitest';
import { isDbKind } from './db-kind.js';

describe('isDbKind', () => {
  it('지원하는 DB 4종을 인식한다', () => {
    for (const kind of ['oracle', 'postgresql', 'mysql', 'mariadb']) {
      expect(isDbKind(kind)).toBe(true);
    }
  });

  it('지원하지 않는 값은 거부한다', () => {
    expect(isDbKind('mssql')).toBe(false);
    expect(isDbKind(undefined)).toBe(false);
  });
});
