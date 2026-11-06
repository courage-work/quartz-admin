import type { BindValue } from '../adapter.js';
import type { QuartzDialect } from '../dialect.js';

/**
 * LIKE 이스케이프 문자. TRD §8.2는 `\`였지만 MySQL은 문자열 리터럴 안에서 `\`를 다시 이스케이프해야 해서
 * DB 4종에서 같은 SQL을 쓰도록 `!`로 정했다.
 */
export const LIKE_ESCAPE = '!';

/** 부분 일치 패턴. `%`, `_`, `!`를 글자 그대로 찾도록 이스케이프하고 양쪽에 `%`를 붙인다 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[!%_]/g, (c) => `${LIKE_ESCAPE}${c}`)}%`;
}

/**
 * 바인드 변수를 순서대로 모은다. 같은 값을 여러 번 써도 자리마다 새 번호를 준다.
 * MySQL의 `?`는 번호로 다시 가리킬 수 없기 때문이다.
 */
export class Binds {
  readonly values: BindValue[] = [];

  constructor(private readonly dialect: QuartzDialect) {}

  /** 값을 추가하고 SQL에 넣을 자리 표시를 돌려준다 */
  add(value: BindValue): string {
    this.values.push(value);
    return this.dialect.param(this.values.length);
  }

  /** `IN (…)` 목록 */
  list(values: readonly BindValue[]): string {
    return values.map((v) => this.add(v)).join(', ');
  }

  /** 다음에 추가될 바인드 번호. 페이지네이션 절이 번호를 미리 알아야 할 때 쓴다 */
  get next(): number {
    return this.values.length + 1;
  }
}

/** 대소문자를 무시한 부분 일치 조건. 컬럼마다 바인드를 따로 쓴다 */
export function containsAny(binds: Binds, columns: readonly string[], text: string): string {
  const pattern = containsPattern(text);
  return `(${columns
    .map((col) => `UPPER(${col}) LIKE UPPER(${binds.add(pattern)}) ESCAPE '${LIKE_ESCAPE}'`)
    .join(' OR ')})`;
}
