import { beforeEach, describe, expect, it } from 'vitest';

import {
  isPreviousUrl,
  recordVisit,
  resetReturnNav,
  resolveReturnHref,
  screenKey,
} from './return-nav';

describe('return-nav', () => {
  beforeEach(() => resetReturnNav());

  it('화면 키는 경로와 id만 쓴다', () => {
    expect(screenKey('/scheduler', new URLSearchParams('id=3&tab=jobs&q=a'))).toBe(
      '/scheduler?id=3',
    );
    expect(screenKey('/connections', new URLSearchParams('q=prod&page=2'))).toBe('/connections');
  });

  it('본 적 없는 화면은 기본 주소로 간다', () => {
    expect(resolveReturnHref('/connections')).toBe('/connections');
  });

  it('마지막으로 본 목록 주소(필터·쪽 포함)로 돌아간다', () => {
    recordVisit('/connections');
    recordVisit('/connections?q=prod');
    recordVisit('/connections?q=prod&page=2');
    recordVisit('/connection?id=5');
    expect(resolveReturnHref('/connections')).toBe('/connections?q=prod&page=2');
  });

  it('같은 상세 화면이면 id가 같은 기록만 쓴다', () => {
    recordVisit('/scheduler?id=1&tab=triggers&state=ERROR');
    recordVisit('/scheduler?id=2&tab=nodes');
    expect(resolveReturnHref('/scheduler?id=1&tab=jobs')).toBe(
      '/scheduler?id=1&tab=triggers&state=ERROR',
    );
    expect(resolveReturnHref('/scheduler?id=3&tab=jobs')).toBe('/scheduler?id=3&tab=jobs');
  });

  it('바로 이전 화면이면 알려 준다. 같은 화면 안에서 주소만 바뀐 것은 이전 화면으로 치지 않는다', () => {
    recordVisit('/');
    recordVisit('/scheduler?id=1');
    recordVisit('/scheduler?id=1&tab=jobs');
    recordVisit('/scheduler?id=1&tab=jobs&q=sync');
    expect(isPreviousUrl('/')).toBe(true);
    expect(isPreviousUrl('/scheduler?id=1')).toBe(false);

    recordVisit('/job?scheduler=1&group=g&name=n');
    expect(isPreviousUrl('/scheduler?id=1&tab=jobs&q=sync')).toBe(true);
  });
});
