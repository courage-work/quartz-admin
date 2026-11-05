/**
 * 비밀값 암호화 (TRD §4.1, PRD NFR-SEC-01)
 *
 * 형식: `v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>`
 * - AES-256-GCM, 메시지마다 96비트 난수 IV, 128비트 인증 태그
 * - AAD(`connections:<id>` 등)로 암호문을 행에 묶어, 다른 행에 옮겨 붙이면 복호화가 실패한다
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretTable = 'connections' | 'channels';

/** 암호문을 저장한 행을 나타내는 AAD */
export function secretAad(table: SecretTable, id: number): string {
  return `${table}:${id}`;
}

export type SecretErrorReason = 'format' | 'unknown-key' | 'auth';

export class SecretDecryptError extends Error {
  readonly reason: SecretErrorReason;

  constructor(reason: SecretErrorReason, message: string) {
    super(message);
    this.name = 'SecretDecryptError';
    this.reason = reason;
  }
}

interface ParsedToken {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export class SecretBox {
  readonly activeKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(keys: ReadonlyMap<string, Buffer>, activeKeyId: string) {
    for (const [id, key] of keys) {
      if (key.length !== 32) throw new Error(`암호화 키 "${id}"는 32바이트여야 합니다`);
    }
    if (!keys.has(activeKeyId)) throw new Error(`활성 키 "${activeKeyId}"가 키 목록에 없습니다`);
    this.keys = keys;
    this.activeKeyId = activeKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keys.get(this.activeKeyId)!, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      this.activeKeyId,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(token: string, aad: string): string {
    const { keyId, iv, tag, ciphertext } = parse(token);
    const key = this.keys.get(keyId);
    if (!key) {
      throw new SecretDecryptError('unknown-key', `암호화 키 "${keyId}"가 설정에 없습니다`);
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // 키가 다르거나, 암호문이 바뀌었거나, 다른 행(AAD)의 암호문인 경우
      throw new SecretDecryptError('auth', '암호문 검증에 실패했습니다');
    }
  }

  keyIdOf(token: string): string {
    return parse(token).keyId;
  }

  /** 활성 키로 암호화돼 있으면 true (rotate-keys 대상이 아님) */
  isCurrent(token: string): boolean {
    return this.keyIdOf(token) === this.activeKeyId;
  }
}

function parse(token: string): ParsedToken {
  const parts = token.split(':');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new SecretDecryptError('format', '지원하지 않는 암호문 형식입니다');
  }
  const [, keyId, iv, tag, ciphertext] = parts as [string, string, string, string, string];
  const parsed = {
    keyId,
    iv: Buffer.from(iv, 'base64'),
    tag: Buffer.from(tag, 'base64'),
    ciphertext: Buffer.from(ciphertext, 'base64'),
  };
  if (parsed.iv.length !== IV_BYTES || parsed.tag.length !== TAG_BYTES) {
    throw new SecretDecryptError('format', '암호문의 IV 또는 인증 태그 길이가 올바르지 않습니다');
  }
  return parsed;
}
