/**
 * 감사 로그 마스킹 필터 (TRD §10, NFR-SEC-03)
 *
 * `target`, `before`, `after`를 저장하기 직전에 통과시킨다. 이름이 비밀값처럼 보이는 키의 값을 가리고,
 * 문자열 안의 URL 자격증명(`scheme://user:pass@host`)도 가린다.
 */

export const MASK = '***';

const MAX_DEPTH = 8;

/** password, passwd, passphrase, secret, token, api key, credential, private key, 인증 헤더, 웹훅 URL */
const SECRET_WORDS =
  /passw(or)?d|passphrase|secret|token|api[-_]?key|credential|private[-_]?key|authorization|cookie|webhook/i;
/** 암호문 컬럼: `passwordEnc`, `configEnc`, `password_enc` */
const ENCRYPTED_SUFFIX = /(Enc|_enc)$/;

export function isSecretKey(key: string): boolean {
  return SECRET_WORDS.test(key) || ENCRYPTED_SUFFIX.test(key);
}

const URL_CREDENTIALS = /(\/\/[^/\s:@]+:)[^/\s@]+@/g;

/**
 * 비밀값을 가린 복사본을 돌려준다. 입력은 바꾸지 않는다.
 *
 * - 비밀 키라도 값이 불리언이나 null이면 그대로 둔다. `{ passwordChanged: true }` 같은 사실은 남기기 위해서다.
 * - JSON으로 저장할 수 없는 값은 설명 문자열로 바꾼다.
 */
export function maskSecrets(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case 'string':
      return value.replace(URL_CREDENTIALS, `$1${MASK}@`);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return null;
  }
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]';
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function') continue;
      out[key] =
        isSecretKey(key) && v !== null && typeof v !== 'boolean' ? MASK : walk(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
