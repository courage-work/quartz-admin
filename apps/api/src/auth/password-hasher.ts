import { type Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * argon2id 비밀번호 해시 (TRD §4.2, OWASP 권장값: memory 19MiB, iterations 2, parallelism 1)
 *
 * `Algorithm`은 ambient const enum이라 isolatedModules에서 값으로 쓸 수 없어 숫자로 지정한다.
 */
const ARGON2ID = 2 as Algorithm.Argon2id;

export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class PasswordHasher {
  /** 없는 계정으로 로그인할 때도 같은 시간이 걸리도록 비교에 쓰는 해시 */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /** 해시 형식이 깨졌으면 예외 대신 false */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** 계정이 없을 때 호출한다. 결과는 항상 false */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('quartz-admin-dummy-password');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
