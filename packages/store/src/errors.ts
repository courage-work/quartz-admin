import type { TargetErrorCode } from '@qa/shared';

export type { TargetErrorCode } from '@qa/shared';

/** 코드별 화면 문구. 드라이버 원문은 접속 정보가 섞일 수 있어 쓰지 않는다 (TRD §5.6) */
export const TARGET_ERROR_MESSAGES: Record<TargetErrorCode, string> = {
  TARGET_UNREACHABLE:
    '대상 DB에 연결할 수 없습니다. 호스트, 포트, 서비스 이름과 네트워크를 확인하세요',
  TARGET_AUTH_FAILED:
    '대상 DB 계정으로 로그인하지 못했습니다. 계정, 비밀번호, 접속 권한을 확인하세요',
  TARGET_TIMEOUT: '대상 DB가 제한 시간 안에 응답하지 않았습니다',
  TARGET_BUSY: '이 접속의 커넥션이 모두 사용 중입니다. 잠시 후 다시 시도하세요',
  LOCK_TIMEOUT: '다른 작업이 잠금을 쥐고 있어 기다리다 중단했습니다. 아무것도 바뀌지 않았습니다',
  TARGET_ERROR: '대상 DB에서 오류가 발생했습니다',
};

/** 같은 요청을 다시 보내면 성공할 수 있는 코드 */
const RETRYABLE: ReadonlySet<TargetErrorCode> = new Set([
  'TARGET_UNREACHABLE',
  'TARGET_TIMEOUT',
  'TARGET_BUSY',
  'LOCK_TIMEOUT',
]);

export interface TargetErrorOptions {
  /** 드라이버 오류 코드(`ORA-01017`, `NJS-503`, `ECONNREFUSED` 등). 접속 정보가 없는 값만 넣는다 */
  driverCode?: string;
  /** 접속 정보를 지운 드라이버 메시지. 서버 로그용이며 API 응답에는 넣지 않는다 */
  detail?: string;
  /** 기본값은 코드로 정한다. 교착 롤백처럼 `TARGET_ERROR`지만 재시도할 수 있는 경우에 넘긴다 */
  retryable?: boolean;
  /** 기본 문구 대신 쓸 한국어 문구 */
  message?: string;
}

/**
 * 대상 DB 접근 오류. 원래 드라이버 오류는 `cause`로 붙이지 않는다.
 * 로거가 `cause`를 그대로 직렬화하면 접속 문자열이나 계정이 로그에 남기 때문이다.
 */
export class TargetError extends Error {
  override readonly name = 'TargetError';
  readonly code: TargetErrorCode;
  readonly driverCode: string | undefined;
  readonly detail: string | undefined;
  readonly retryable: boolean;

  constructor(code: TargetErrorCode, options: TargetErrorOptions = {}) {
    super(options.message ?? TARGET_ERROR_MESSAGES[code]);
    this.code = code;
    this.driverCode = options.driverCode;
    this.detail = options.detail;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  /** 이 오류 뒤에 커넥션을 다시 쓰면 안 되는지. 끊겼거나 응답 도중 멈춘 커넥션은 풀에 돌려놓지 않는다 */
  get connectionBroken(): boolean {
    return this.code === 'TARGET_UNREACHABLE' || this.code === 'TARGET_TIMEOUT';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      driverCode: this.driverCode,
      detail: this.detail,
      retryable: this.retryable,
    };
  }
}

export function isTargetError(value: unknown): value is TargetError {
  return value instanceof TargetError;
}

/** 오류 메시지에서 지울 접속 정보. 비어 있는 값은 무시한다 */
export interface RedactValues {
  host?: string | undefined;
  port?: number | undefined;
  username?: string | undefined;
  password?: string | undefined;
  /** DB 이름, Oracle 서비스 이름, SID, 스키마 */
  names?: readonly (string | undefined)[];
}

const MASK = '***';

/**
 * 드라이버 메시지에서 접속 정보(호스트, 포트, 계정, 비밀번호, 서비스·DB·스키마 이름, IP 주소, 접속 기술자)를 지운다.
 * 값 자체를 찾아 지우고, 드라이버가 쓰는 형식(`host X port N`, `(HOST=X)`)도 함께 지운다.
 */
export function redactConnectionInfo(text: string, values: RedactValues = {}): string {
  let out = text;
  // 긴 값부터 지워야 짧은 값이 긴 값 일부를 먼저 지워 나머지가 남는 일이 없다
  const literals = [values.password, values.host, values.username, ...(values.names ?? [])]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const literal of literals) {
    out = out.replace(new RegExp(escapeRegExp(literal), 'gi'), MASK);
  }
  out = out
    // Oracle 접속 기술자: (HOST=...)(PORT=...)(SERVICE_NAME=...)(SID=...)(USER=...)
    .replace(
      /\((HOST|PORT|SERVICE_NAME|SID|USER|SERVER|INSTANCE_NAME|CID)\s*=[^)]*\)/gi,
      `($1=${MASK})`,
    )
    // oracledb Thin 메시지: "host X port N", "at host X port N"
    .replace(/\bhost\s+\S+\s+port\s+\S+/gi, `host ${MASK} port ${MASK}`)
    // pg·mysql2 메시지: "connect ECONNREFUSED 10.0.0.1:5432", "getaddrinfo ENOTFOUND db.local"
    .replace(/\b(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b/g, MASK)
    .replace(/\[[0-9a-f:]+\](?::\d+)?/gi, MASK)
    .replace(/\b(ENOTFOUND|EAI_AGAIN)\s+\S+/g, `$1 ${MASK}`)
    .replace(/\bCONNECTION_ID=[^)\s]+/gi, `CONNECTION_ID=${MASK}`)
    // "user "SCOTT"", "for user 'scott'", "role "x""
    .replace(/\b(user|role|database|schema)\s+(["'`])[^"'`]*\2/gi, `$1 $2${MASK}$2`);
  if (values.port !== undefined) {
    out = out.replace(new RegExp(`(?<=[:\\s=])${values.port}\\b`, 'g'), MASK);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Node 소켓 오류 코드. 드라이버가 감싸지 않고 그대로 올리는 경우가 있다 */
const NODE_NET_CODES: Partial<Record<string, TargetErrorCode>> = {
  ECONNREFUSED: 'TARGET_UNREACHABLE',
  ECONNRESET: 'TARGET_UNREACHABLE',
  EPIPE: 'TARGET_UNREACHABLE',
  ENOTFOUND: 'TARGET_UNREACHABLE',
  EAI_AGAIN: 'TARGET_UNREACHABLE',
  EHOSTUNREACH: 'TARGET_UNREACHABLE',
  ENETUNREACH: 'TARGET_UNREACHABLE',
  ETIMEDOUT: 'TARGET_TIMEOUT',
};

/** Node 소켓 오류면 분류 결과를, 아니면 `undefined`를 돌려준다 */
export function classifyNodeNetError(code: string | undefined): TargetErrorCode | undefined {
  return code === undefined ? undefined : NODE_NET_CODES[code];
}

/** 알 수 없는 값에서 문자열 속성 하나를 꺼낸다 */
export function stringProp(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}
