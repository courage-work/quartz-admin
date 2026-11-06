import { describe, expect, it, vi } from 'vitest';

import { ApiRequestError, buildUrl, createApiClient, isApiError } from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(response: Response | Error, onUnauthenticated = vi.fn()) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return { request: createApiClient({ fetch, onUnauthenticated }), fetch, onUnauthenticated };
}

describe('buildUrl', () => {
  it('API 접두어를 붙이고 비어 있는 쿼리 값은 뺀다', () => {
    expect(buildUrl('/audit-logs', { action: 'auth.login', cursor: undefined, username: '' })).toBe(
      '/api/v1/audit-logs?action=auth.login',
    );
    expect(buildUrl('/auth/me')).toBe('/api/v1/auth/me');
    expect(buildUrl('/x', { q: 'a b&c' })).toBe('/api/v1/x?q=a+b%26c');
  });
});

describe('createApiClient', () => {
  it('GET에는 CSRF 헤더를 붙이지 않고 같은 오리진 쿠키를 보낸다', async () => {
    const { request, fetch } = client(jsonResponse(200, { id: 1 }));
    await expect(request('/auth/me')).resolves.toEqual({ id: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/auth/me');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).not.toHaveProperty('X-QA-Request');
  });

  it('상태를 바꾸는 요청에는 CSRF 헤더와 JSON 본문을 붙인다', async () => {
    const { request, fetch } = client(new Response(null, { status: 204 }));
    await expect(
      request('/users/3', { method: 'PATCH', body: { isActive: false } }),
    ).resolves.toBeUndefined();
    const init = fetch.mock.calls[0]![1]!;
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ 'X-QA-Request': '1', 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"isActive":false}');
  });

  it('오류 응답을 코드와 한국어 메시지를 가진 ApiRequestError로 바꾼다', async () => {
    const { request } = client(
      jsonResponse(409, { code: 'USERNAME_TAKEN', message: '이미 있는 아이디입니다: a' }),
    );
    const err = await request('/users', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 409,
      code: 'USERNAME_TAKEN',
      message: '이미 있는 아이디입니다: a',
    });
    expect(isApiError(err, 'USERNAME_TAKEN')).toBe(true);
    expect((err as ApiRequestError).isClientError).toBe(true);
  });

  it('검증 실패의 필드별 원인을 넘겨준다', async () => {
    const details = [{ path: 'password', message: '비밀번호는 8자 이상이어야 합니다' }];
    const { request } = client(
      jsonResponse(400, {
        code: 'VALIDATION_FAILED',
        message: '입력값이 올바르지 않습니다',
        details,
      }),
    );
    await expect(request('/users', { method: 'POST', body: {} })).rejects.toMatchObject({
      details,
    });
  });

  it('형식을 알 수 없는 오류 응답도 ApiRequestError로 바꾼다', async () => {
    const { request } = client(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(request('/x')).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('서버에 닿지 못하면 NETWORK_ERROR를 준다', async () => {
    const { request } = client(new TypeError('Failed to fetch'));
    await expect(request('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('요청을 취소하면 취소 오류를 그대로 던진다', async () => {
    const { request } = client(new DOMException('aborted', 'AbortError'));
    await expect(request('/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('세션 만료(401 UNAUTHENTICATED)면 로그인 이동 처리를 부른다', async () => {
    const { request, onUnauthenticated } = client(
      jsonResponse(401, { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다' }),
    );
    await expect(request('/users')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('skipAuthRedirect이거나 로그인 실패(401 INVALID_CREDENTIALS)면 부르지 않는다', async () => {
    const me = client(
      jsonResponse(401, { code: 'UNAUTHENTICATED', message: '로그인이 필요합니다' }),
    );
    await me.request('/auth/me', { skipAuthRedirect: true }).catch(() => undefined);
    expect(me.onUnauthenticated).not.toHaveBeenCalled();

    const login = client(
      jsonResponse(401, {
        code: 'INVALID_CREDENTIALS',
        message: '아이디 또는 비밀번호가 맞지 않습니다',
      }),
    );
    await login.request('/auth/login', { method: 'POST', body: {} }).catch(() => undefined);
    expect(login.onUnauthenticated).not.toHaveBeenCalled();
  });
});
