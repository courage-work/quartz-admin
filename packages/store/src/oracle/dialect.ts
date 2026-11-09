import type { TargetConn } from '../adapter.js';
import type { CatalogQueries, QuartzDialect } from '../dialect.js';
import { TargetError } from '../errors.js';
import { readBlob, readBool, readLong } from '../normalize.js';

const CATALOG: CatalogQueries = {
  currentSchema: `SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS SCHEMA_NAME FROM DUAL`,
  tables: `SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = :p1 ORDER BY TABLE_NAME`,
  columns:
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS ` +
    `WHERE OWNER = :p1 ORDER BY TABLE_NAME, COLUMN_ID`,
};

/**
 * DB 현재 시각(epoch ms). `SYSTIMESTAMP`를 UTC로 바꿔 초 단위는 DATE 뺄셈으로, 밀리초는 `FF3`로 구한다.
 * 12.1 문법만 쓴다 (TRD §5.1, §5.3).
 */
const DB_NOW_MS_SQL =
  `SELECT (CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE) - DATE '1970-01-01') * 86400000` +
  ` + TO_NUMBER(TO_CHAR(SYSTIMESTAMP, 'FF3')) AS NOW_MS FROM DUAL`;

/**
 * Oracle용 `QuartzDialect` (TRD §5.3). 바인드는 `:p1`, 식별자는 큰따옴표, 잠금 대기는 `FOR UPDATE WAIT n`이다.
 *
 * 바인드 이름을 `:1`이 아닌 `:p1`로 쓰는 이유: oracledb는 배열 바인드를 이름의 숫자가 아니라 SQL에 나온 순서대로
 * 붙인다. `OFFSET :2 ROWS FETCH NEXT :1 ROWS ONLY`에 `[limit, offset]`을 넘기면 둘이 뒤바뀐다(S3에서 확인).
 * 어댑터가 배열을 `{ p1, p2, … }` 이름 바인드로 바꿔 넘기므로 번호가 그대로 자리를 가리킨다.
 *
 * Oracle은 DML이 행 잠금을 무기한 기다리므로 세션 설정으로는 대기를 제한할 수 없다. 그래서 잠금 전후 처리가 없다.
 */
export const oracleDialect: QuartzDialect = {
  kind: 'oracle',
  param(index) {
    if (!Number.isInteger(index) || index < 1)
      throw new RangeError(`바인드 번호가 잘못됐습니다: ${index}`);
    return `:p${index}`;
  },
  quote(ident) {
    if (ident.length === 0 || ident.includes('"') || ident.includes('\u0000')) {
      throw new Error('식별자로 쓸 수 없는 값입니다');
    }
    return `"${ident}"`;
  },
  paginate(sql, limitParam, offsetParam) {
    return `${sql} OFFSET ${this.param(offsetParam)} ROWS FETCH NEXT ${this.param(limitParam)} ROWS ONLY`;
  },
  forUpdate(waitSec) {
    if (!Number.isInteger(waitSec) || waitSec < 0)
      throw new RangeError(`잠금 대기 시간이 잘못됐습니다: ${waitSec}`);
    return `FOR UPDATE WAIT ${waitSec}`;
  },
  async beforeLockedTx(_conn: TargetConn, _lockWaitSec: number) {
    // 기본 격리 수준(READ COMMITTED)을 쓰고, 잠금 대기는 `forUpdate`로 제한한다
  },
  async afterLockedTx(_conn: TargetConn) {
    // 바꾼 세션 설정이 없다
  },
  dbNowMillisSql: () => DB_NOW_MS_SQL,
  catalog: CATALOG,
  readBool,
  readBlob,
  readLong,
  // ORA-00001: 고유 제약 위반
  isDuplicateKey: (err) => err instanceof TargetError && err.driverCode === 'ORA-00001',
};
