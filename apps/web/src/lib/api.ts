import { API_PREFIX, type ApiErrorBody, type ApiErrorCode, CSRF_HEADER } from '@qa/shared';

/** 서버 응답을 받지 못한 경우의 코드. 서버 오류 코드(`ApiErrorCode`)와 구분한다 */
export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR';

/** API 오류. 화면은 `code`로 분기하고 `message`(한국어)를 그대로 보여준다 (TRD §2.3) */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details: ApiErrorBody['details'] = undefined,
    /** 지원 문의용 정보. 서버 로그를 찾는 요청 ID(`X-Request-Id`)와 요청 경로 */
    readonly context: { method?: string; path?: string; requestId?: string | null } = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** 다시 시도해도 결과가 같은 오류(4xx) */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** 서버·네트워크 문제(5xx, 연결 실패). 화면에 "오류 정보 복사"를 함께 둔다 (VectorLab errors) */
  get isTechnical(): boolean {
    return this.status === 0 || this.status >= 500;
  }

  /** 지원 문의에 붙여 넣을 오류 정보. 스택이나 응답 원문은 넣지 않는다 */
  supportText(now: Date = new Date()): string {
    return [
      `시각: ${now.toISOString()}`,
      `요청: ${this.context.method ?? '-'} ${this.context.path ?? '-'}`,
      `상태: ${this.status} ${this.code}`,
      `요청 ID: ${this.context.requestId ?? '-'}`,
      `메시지: ${this.message}`,
    ].join('\n');
  }
}

export function isApiError(err: unknown, code?: ClientErrorCode): err is ApiRequestError {
  return err instanceof ApiRequestError && (code === undefined || err.code === code);
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /** 401이어도 로그인 화면으로 보내지 않는다. 로그인 여부를 확인하는 요청(`/auth/me`)에 쓴다 */
  skipAuthRedirect?: boolean;
}

export interface ApiClientDeps {
  fetch: typeof fetch;
  /** 세션이 없거나 만료된 응답(401 `UNAUTHENTICATED`)을 받았을 때 */
  onUnauthenticated?: () => void;
}

const NETWORK_MESSAGE = '서버에 연결하지 못했습니다. 네트워크 상태를 확인하고 다시 시도하세요';
const UNKNOWN_MESSAGE = '서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도하세요';

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `/${API_PREFIX}${path}${qs ? `?${qs}` : ''}`;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiErrorBody).code === 'string' &&
    typeof (value as ApiErrorBody).message === 'string'
  );
}

/**
 * 같은 오리진의 `/api/v1`을 부르는 클라이언트.
 * 상태를 바꾸는 요청에는 CSRF 헤더(`X-QA-Request: 1`)를 붙인다. `Origin`은 브라우저가 붙인다 (TRD §4.3).
 */
export function createApiClient(deps: ApiClientDeps) {
  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers[CSRF_HEADER] = '1';

    let res: Response;
    try {
      res = await deps.fetch(buildUrl(path, options.query), {
        method,
        headers,
        credentials: 'same-origin',
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiRequestError(0, 'NETWORK_ERROR', NETWORK_MESSAGE, undefined, { method, path });
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }

    const body: unknown = await res.json().catch(() => null);
    const context = { method, path, requestId: res.headers.get('X-Request-Id') };
    const error = isErrorBody(body)
      ? new ApiRequestError(res.status, body.code, body.message, body.details, context)
      : new ApiRequestError(res.status, 'INTERNAL_ERROR', UNKNOWN_MESSAGE, undefined, context);
    if (error.status === 401 && error.code === 'UNAUTHENTICATED' && !options.skipAuthRedirect) {
      deps.onUnauthenticated?.();
    }
    throw error;
  };
}

let unauthenticatedHandler: (() => void) | undefined;

/** 세션 만료 시 동작을 등록한다. `QueryProvider`가 로그인 화면 이동을 등록한다 */
export function setUnauthenticatedHandler(handler: (() => void) | undefined): void {
  unauthenticatedHandler = handler;
}

export const api = createApiClient({
  fetch: (...args) => fetch(...args),
  onUnauthenticated: () => unauthenticatedHandler?.(),
});
