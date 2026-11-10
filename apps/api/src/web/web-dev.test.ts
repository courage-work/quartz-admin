import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { startWebDev, webDevMiddleware } from './web-dev.js';

function call(path: string) {
  const handle = vi.fn(() => Promise.resolve());
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  const res = { removeHeader: vi.fn() };
  webDevMiddleware(handle, 'api/v1')({ path } as Request, res as unknown as Response, next);
  return { handle, next, res };
}

describe('webDevMiddleware (QA_WEB_DEV)', () => {
  it('API와 헬스체크는 Nest로 넘긴다', () => {
    for (const path of ['/api/v1', '/api/v1/auth/me', '/healthz', '/readyz']) {
      const { handle, next } = call(path);
      expect(handle).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('그 밖의 경로는 CSP를 빼고 Next 개발 서버로 넘긴다', () => {
    for (const path of ['/', '/scheduler', '/_next/webpack-hmr', '/api-docs']) {
      const { handle, next, res } = call(path);
      expect(handle).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
      expect(res.removeHeader).toHaveBeenCalledWith('Content-Security-Policy');
    }
  });

  it('웹 소스가 없으면 설정 오류로 기동을 멈춘다', async () => {
    await expect(startWebDev('/nonexistent/web', 3000)).rejects.toMatchObject({
      name: 'ConfigError',
    });
  });
});
