import { describe, expect, it } from 'vitest';

import { loginHref, safeNextPath } from './navigation';

describe('safeNextPath', () => {
  it('같은 오리진의 경로는 쿼리까지 그대로 둔다', () => {
    expect(safeNextPath('/audit-log?id=3')).toBe('/audit-log?id=3');
    expect(safeNextPath('/users')).toBe('/users');
  });

  it('다른 오리진으로 갈 수 있는 값은 홈으로 바꾼다', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'https://evil.example',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      '/users\n/x',
    ]) {
      expect(safeNextPath(bad), String(bad)).toBe('/');
    }
  });

  it('로그인 화면 자신으로는 돌려보내지 않는다', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?next=/users')).toBe('/');
  });
});

describe('loginHref', () => {
  it('지금 경로를 next로 붙인다', () => {
    expect(loginHref('/audit-log', '?id=3')).toBe('/login?next=%2Faudit-log%3Fid%3D3');
  });

  it('홈이나 로그인 화면이면 next를 붙이지 않는다', () => {
    expect(loginHref('/')).toBe('/login');
    expect(loginHref('/login', '?next=/x')).toBe('/login');
  });
});
