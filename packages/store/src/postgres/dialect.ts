import type { TargetConn } from '../adapter.js';
import type { CatalogQueries, QuartzDialect } from '../dialect.js';
import { TargetError } from '../errors.js';
import { readBlob, readBool, readLong } from '../normalize.js';
import { PG_UNIQUE_VIOLATION } from './errors.js';

/**
 * `information_schema`. 결과 컬럼 이름은 다른 DB와 같게 대문자 별칭으로 고정한다.
 * 이름은 카탈로그에 저장된 그대로(따옴표 없이 만든 Quartz 테이블은 소문자) 돌려준다.
 */
const CATALOG: CatalogQueries = {
  currentSchema: `SELECT current_schema() AS "SCHEMA_NAME"`,
  tables:
    `SELECT table_name AS "TABLE_NAME" FROM information_schema.tables ` +
    `WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
  columns:
    `SELECT table_name AS "TABLE_NAME", column_name AS "COLUMN_NAME", data_type AS "DATA_TYPE" ` +
    `FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
};

/** DB 현재 시각(epoch ms). `now()`는 트랜잭션 시작 시각이라 실제 시각인 `clock_timestamp()`를 쓴다 */
const DB_NOW_MS_SQL = `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "NOW_MS"`;

/**
 * PostgreSQL용 `QuartzDialect` (TRD §5.3). 바인드는 `$1`, 식별자는 큰따옴표(감지한 실제 대소문자),
 * 잠금 대기는 트랜잭션 안의 `SET LOCAL lock_timeout`으로 제한한다. 대기 초과는 SQLSTATE 55P03(`LOCK_TIMEOUT`)이다.
 */
export const postgresDialect: QuartzDialect = {
  kind: 'postgresql',
  param(index) {
    if (!Number.isInteger(index) || index < 1)
      throw new RangeError(`바인드 번호가 잘못됐습니다: ${index}`);
    return `$${index}`;
  },
  quote(ident) {
    if (ident.length === 0 || ident.includes('"') || ident.includes('\u0000')) {
      throw new Error('식별자로 쓸 수 없는 값입니다');
    }
    return `"${ident}"`;
  },
  paginate(sql, limitParam, offsetParam) {
    return `${sql} LIMIT ${this.param(limitParam)} OFFSET ${this.param(offsetParam)}`;
  },
  forUpdate(waitSec) {
    if (!Number.isInteger(waitSec) || waitSec < 0)
      throw new RangeError(`잠금 대기 시간이 잘못됐습니다: ${waitSec}`);
    // 대기 제한은 beforeLockedTx의 lock_timeout이 맡는다
    return 'FOR UPDATE';
  },
  /**
   * 트랜잭션을 시작하고 그 트랜잭션에만 잠금 대기 제한을 건다. `SET LOCAL`은 COMMIT·ROLLBACK과 함께 사라지므로
   * 원복이 필요 없다. 격리 수준은 기본값(READ COMMITTED)이다
   */
  async beforeLockedTx(conn: TargetConn, lockWaitSec: number) {
    if (!Number.isInteger(lockWaitSec) || lockWaitSec < 0)
      throw new RangeError(`잠금 대기 시간이 잘못됐습니다: ${lockWaitSec}`);
    await conn.execute(`SET LOCAL lock_timeout = '${lockWaitSec}s'`);
  },
  async afterLockedTx(_conn: TargetConn) {
    // SET LOCAL은 트랜잭션이 끝나면 사라진다
  },
  dbNowMillisSql: () => DB_NOW_MS_SQL,
  catalog: CATALOG,
  readBool,
  readBlob,
  readLong,
  isDuplicateKey: (err) => err instanceof TargetError && err.driverCode === PG_UNIQUE_VIOLATION,
};
