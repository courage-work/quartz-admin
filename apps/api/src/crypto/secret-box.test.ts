import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, SecretDecryptError, secretAad } from './secret-box.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const aad = secretAad('connections', 1);

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SecretDecryptError) return err.reason;
    throw err;
  }
  return 'no-error';
}

describe('SecretBox', () => {
  const box = new SecretBox(new Map([['k1', k1]]), 'k1');

  it('암호화한 값을 같은 AAD로 복호화한다 (빈 문자열, 유니코드 포함)', () => {
    for (const plaintext of ['s3cret!', '', '비밀번호🔑']) {
      expect(box.decrypt(box.encrypt(plaintext, aad), aad)).toBe(plaintext);
    }
  });

  it('v1:<keyId>:<iv>:<tag>:<ct> 형식이고 매번 IV가 달라 같은 평문도 암호문이 다르다', () => {
    const a = box.encrypt('same', aad);
    const b = box.encrypt('same', aad);
    expect(a).toMatch(/^v1:k1:[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('same');
  });

  it('다른 행의 AAD로 복호화하면 실패한다', () => {
    const token = box.encrypt('pw', secretAad('connections', 1));
    expect(reasonOf(() => box.decrypt(token, secretAad('connections', 2)))).toBe('auth');
    expect(reasonOf(() => box.decrypt(token, secretAad('channels', 1)))).toBe('auth');
  });

  it('암호문이나 태그를 바꾸면 실패한다', () => {
    const parts = box.encrypt('pw', aad).split(':');
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString('base64');
    };
    const badCt = [...parts.slice(0, 4), flip(parts[4]!)].join(':');
    const badTag = [...parts.slice(0, 3), flip(parts[3]!), parts[4]].join(':');
    expect(reasonOf(() => box.decrypt(badCt, aad))).toBe('auth');
    expect(reasonOf(() => box.decrypt(badTag, aad))).toBe('auth');
  });

  it('잘린 태그, 알 수 없는 버전·형식, 설정에 없는 키를 구분해 거부한다', () => {
    const parts = box.encrypt('pw', aad).split(':');
    const shortTag = [...parts.slice(0, 3), parts[3]!.slice(0, 8), parts[4]].join(':');
    expect(reasonOf(() => box.decrypt(shortTag, aad))).toBe('format');
    expect(reasonOf(() => box.decrypt(`v2:${parts.slice(1).join(':')}`, aad))).toBe('format');
    expect(reasonOf(() => box.decrypt('plain-password', aad))).toBe('format');

    const other = new SecretBox(new Map([['k2', k2]]), 'k2');
    expect(reasonOf(() => other.decrypt(box.encrypt('pw', aad), aad))).toBe('unknown-key');
  });

  it('키를 교체해도 이전 키의 암호문을 읽고, 새 암호문은 활성 키로 만든다', () => {
    const old = box.encrypt('pw', aad);
    const rotated = new SecretBox(
      new Map([
        ['k1', k1],
        ['k2', k2],
      ]),
      'k2',
    );
    expect(rotated.decrypt(old, aad)).toBe('pw');
    expect(rotated.isCurrent(old)).toBe(false);
    const fresh = rotated.encrypt('pw', aad);
    expect(rotated.keyIdOf(fresh)).toBe('k2');
    expect(rotated.isCurrent(fresh)).toBe(true);
  });

  it('잘못된 키 설정으로는 만들 수 없다', () => {
    expect(() => new SecretBox(new Map([['k1', randomBytes(16)]]), 'k1')).toThrow(/32바이트/);
    expect(() => new SecretBox(new Map([['k1', k1]]), 'k2')).toThrow(/활성 키/);
  });
});
