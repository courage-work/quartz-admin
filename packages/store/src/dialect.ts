import type { TargetConn } from './adapter.js';
import type { DbKind } from './db-kind.js';
import { TargetError } from './errors.js';

/**
 * 카탈로그 조회 SQL. 자동 감지(B-12)가 쓴다. 결과 컬럼 이름은 별칭으로 고정한다.
 * - `currentSchema`: 1행, `SCHEMA_NAME`
 * - `tables`: 바인드 1 = 스키마. `TABLE_NAME`
 * - `columns`: 바인드 1 = 스키마. `TABLE_NAME`, `COLUMN_NAME`, `DATA_TYPE`
 */
export interface CatalogQueries {
  readonly currentSchema: string;
  readonly tables: string;
  readonly columns: string;
}

/** DB별 SQL 차이 (TRD §5.3). 쿼리 빌더는 이 인터페이스만 보고 SQL을 만든다 */
export interface QuartzDialect {
  readonly kind: DbKind;
  /** n번째(1부터) 바인드 자리 */
  param(index: number): string;
  /** 식별자를 따옴표로 감싼다. 감지한 실제 대소문자를 그대로 넘긴다 */
  quote(ident: string): string;
  /** `sql` 뒤에 페이지네이션 절을 붙인다. 인자는 바인드 번호다 */
  paginate(sql: string, limitParam: number, offsetParam: number): string;
  /** 잠금 SELECT 끝에 붙이는 절 */
  forUpdate(waitSec: number): string;
  /** 잠금을 쓰는 트랜잭션을 시작하기 전 세션 설정(잠금 대기 제한, 격리 수준) */
  beforeLockedTx(conn: TargetConn, lockWaitSec: number): Promise<void>;
  /** `beforeLockedTx`에서 바꾼 세션 설정 원복 */
  afterLockedTx(conn: TargetConn): Promise<void>;
  /** DB 현재 시각(epoch ms)을 1행 1열로 돌려주는 SELECT */
  dbNowMillisSql(): string;
  readonly catalog: CatalogQueries;
  readBool(value: unknown): boolean | null;
  readBlob(value: unknown): Buffer | null;
  readLong(value: unknown): number | null;
  /** 고유 키 중복으로 INSERT가 실패한 오류인지. 잠금 행을 동시에 넣은 경우를 가려낸다 (TRD §7.1 c) */
  isDuplicateKey(err: unknown): boolean;
}

/** DB 현재 시각(epoch ms). 시계 차이 계산과 misfire 판정에 쓴다 (TRD §8) */
export async function queryDbNowMillis(conn: TargetConn, dialect: QuartzDialect): Promise<number> {
  const rows = await conn.query(dialect.dbNowMillisSql());
  const value = rows[0] === undefined ? undefined : Object.values(rows[0])[0];
  const now = dialect.readLong(value);
  if (now === null) {
    throw new TargetError('TARGET_ERROR', { detail: 'DB 현재 시각 조회 결과가 비어 있습니다' });
  }
  return now;
}
