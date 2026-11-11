import type { TargetConn } from '../adapter.js';
import type { CatalogQueries, QuartzDialect } from '../dialect.js';
import { TargetError } from '../errors.js';
import { readBlob, readBool, readLong } from '../normalize.js';
import { MYSQL_DUP_ENTRY } from './errors.js';

/**
 * `information_schema`. 스키마는 MySQL의 DB다. 결과 컬럼 이름은 다른 DB와 같게 대문자 별칭으로 고정한다.
 * 바인드는 이 dialect의 `:p1` 형식(어댑터가 `?`로 바꾼다).
 */
const CATALOG: CatalogQueries = {
  currentSchema: 'SELECT DATABASE() AS `SCHEMA_NAME`',
  tables:
    'SELECT TABLE_NAME AS `TABLE_NAME` FROM information_schema.TABLES ' +
    "WHERE TABLE_SCHEMA = :p1 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
  columns:
    'SELECT TABLE_NAME AS `TABLE_NAME`, COLUMN_NAME AS `COLUMN_NAME`, DATA_TYPE AS `DATA_TYPE` ' +
    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, ORDINAL_POSITION',
};

/** DB 현재 시각(epoch ms). `UNIX_TIMESTAMP`는 세션 시간대와 상관없이 UTC 기준이다. 5.7 문법만 쓴다 */
const DB_NOW_MS_SQL = 'SELECT CAST(ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000) AS SIGNED) AS `NOW_MS`';

/**
 * MySQL용 `QuartzDialect` (TRD §5.3). 식별자는 백틱, 페이지는 `LIMIT … OFFSET`, 잠금 대기는 세션
 * `innodb_lock_wait_timeout`으로 제한하고 트랜잭션이 끝나면 원래 값(전역 기본값)으로 되돌린다.
 * 대기 초과는 1205(`LOCK_TIMEOUT`)다. 5.7을 지원하므로 `NOWAIT`·`SKIP LOCKED`·CTE·윈도 함수를 쓰지 않는다.
 *
 * 바인드 자리는 `?` 대신 `:pN`으로 만든다. MySQL의 `?`는 번호로 가리킬 수 없으므로, 어댑터가 SQL에 나온 순서대로
 * `?`로 바꾸고 값을 늘어놓는다(`toMysqlPlaceholders`).
 */
export const mysqlDialect: QuartzDialect = {
  kind: 'mysql',
  param(index) {
    if (!Number.isInteger(index) || index < 1)
      throw new RangeError(`바인드 번호가 잘못됐습니다: ${index}`);
    return `:p${index}`;
  },
  quote(ident) {
    if (ident.length === 0 || ident.includes('`') || ident.includes('\u0000')) {
      throw new Error('식별자로 쓸 수 없는 값입니다');
    }
    return `\`${ident}\``;
  },
  paginate(sql, limitParam, offsetParam) {
    return `${sql} LIMIT ${this.param(limitParam)} OFFSET ${this.param(offsetParam)}`;
  },
  forUpdate(waitSec) {
    if (!Number.isInteger(waitSec) || waitSec < 0)
      throw new RangeError(`잠금 대기 시간이 잘못됐습니다: ${waitSec}`);
    // 대기 제한은 beforeLockedTx의 innodb_lock_wait_timeout이 맡는다
    return 'FOR UPDATE';
  },
  async beforeLockedTx(conn: TargetConn, lockWaitSec: number) {
    if (!Number.isInteger(lockWaitSec) || lockWaitSec < 1)
      throw new RangeError(`잠금 대기 시간이 잘못됐습니다: ${lockWaitSec}`);
    await conn.execute(`SET SESSION innodb_lock_wait_timeout = ${lockWaitSec}`);
  },
  /** 세션 값을 전역 기본값으로 되돌린다. 풀에 돌아간 커넥션의 다른 작업에 짧은 대기 제한이 남지 않게 한다 */
  async afterLockedTx(conn: TargetConn) {
    await conn.execute('SET SESSION innodb_lock_wait_timeout = DEFAULT');
  },
  dbNowMillisSql: () => DB_NOW_MS_SQL,
  catalog: CATALOG,
  readBool,
  readBlob,
  readLong,
  isDuplicateKey: (err) => err instanceof TargetError && err.driverCode === MYSQL_DUP_ENTRY,
};
