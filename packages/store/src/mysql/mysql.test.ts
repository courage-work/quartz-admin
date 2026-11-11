import { describe, expect, it } from 'vitest';
import type { TargetConn, TargetConnectInfo } from '../adapter.js';
import { TargetError } from '../errors.js';
import { toMysqlPlaceholders } from './adapter.js';
import { mysqlDialect } from './dialect.js';
import { toMysqlTargetError } from './errors.js';

const info: TargetConnectInfo = {
  kind: 'mysql',
  host: 'my-prod.corp.example',
  port: 3306,
  username: 'quartz_app',
  password: 'Sup3r-secret',
  database: 'scheduler',
};

function myError(fields: { code?: string; errno?: number }, message: string): Error {
  return Object.assign(new Error(message), fields);
}

describe('mysqlDialect', () => {
  it('바인드, 식별자, 페이지네이션, 잠금 절 (TRD §5.3)', () => {
    expect(mysqlDialect.param(3)).toBe(':p3');
    expect(() => mysqlDialect.param(0)).toThrow(RangeError);
    expect(mysqlDialect.quote('QRTZ_TRIGGERS')).toBe('`QRTZ_TRIGGERS`');
    expect(() => mysqlDialect.quote('a`b')).toThrow();
    expect(mysqlDialect.paginate('SELECT 1 ORDER BY 1', 2, 3)).toBe(
      'SELECT 1 ORDER BY 1 LIMIT :p2 OFFSET :p3',
    );
    expect(mysqlDialect.forUpdate(5)).toBe('FOR UPDATE');
  });

  it('잠금 트랜잭션 앞에서 세션 잠금 대기 제한을 걸고, 끝나면 기본값으로 되돌린다', async () => {
    const executed: string[] = [];
    const conn = {
      execute: (sql: string) => {
        executed.push(sql);
        return Promise.resolve(0);
      },
    } as unknown as TargetConn;
    await mysqlDialect.beforeLockedTx(conn, 5);
    await mysqlDialect.afterLockedTx(conn);
    expect(executed).toEqual([
      'SET SESSION innodb_lock_wait_timeout = 5',
      'SET SESSION innodb_lock_wait_timeout = DEFAULT',
    ]);
  });

  it('현재 시각은 UTC epoch ms, 카탈로그는 현재 DB와 대문자 별칭', () => {
    expect(mysqlDialect.dbNowMillisSql()).toContain('UNIX_TIMESTAMP(NOW(3))');
    expect(mysqlDialect.catalog.currentSchema).toContain('DATABASE()');
    expect(mysqlDialect.catalog.tables).toContain('`TABLE_NAME`');
  });

  it('고유 키 중복(ER_DUP_ENTRY)을 가려낸다', () => {
    expect(
      mysqlDialect.isDuplicateKey(new TargetError('TARGET_ERROR', { driverCode: 'ER_DUP_ENTRY' })),
    ).toBe(true);
  });
});

describe('toMysqlPlaceholders', () => {
  it('SQL에 나온 순서대로 ?로 바꾸고 값을 늘어놓는다. 순서가 뒤바뀌거나 같은 번호를 다시 써도 맞다', () => {
    expect(toMysqlPlaceholders('SELECT :p2, :p1, :p2', ['a', 'b'])).toEqual({
      sql: 'SELECT ?, ?, ?',
      values: ['b', 'a', 'b'],
    });
    expect(() => toMysqlPlaceholders('SELECT :p3', ['a'])).toThrow(TargetError);
  });
});

describe('toMysqlTargetError', () => {
  it.each([
    [
      { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 },
      "Access denied for user 'quartz_app'@'10.0.0.5'",
      'TARGET_AUTH_FAILED',
    ],
    [
      { code: 'ER_BAD_DB_ERROR', errno: 1049 },
      "Unknown database 'scheduler'",
      'TARGET_UNREACHABLE',
    ],
    [
      { code: 'ER_QUERY_TIMEOUT', errno: 3024 },
      'Query execution was interrupted, maximum statement execution time exceeded',
      'TARGET_TIMEOUT',
    ],
    [{ code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }, 'Lock wait timeout exceeded', 'LOCK_TIMEOUT'],
    [{ code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 }, 'UPDATE command denied', 'TARGET_ERROR'],
    [{ code: 'PROTOCOL_SEQUENCE_TIMEOUT' }, 'Query inactivity timeout', 'TARGET_TIMEOUT'],
    [
      { code: 'PROTOCOL_CONNECTION_LOST' },
      'Connection lost: The server closed the connection.',
      'TARGET_UNREACHABLE',
    ],
    [{ code: 'ECONNREFUSED' }, 'connect ECONNREFUSED 10.0.0.5:3306', 'TARGET_UNREACHABLE'],
    [{ code: 'ETIMEDOUT' }, 'connect ETIMEDOUT', 'TARGET_TIMEOUT'],
  ] as const)('%o → %s', (fields, message, expected) => {
    expect(toMysqlTargetError(myError(fields, message), info).code).toBe(expected);
  });

  it('교착(1213)은 다시 시도할 수 있고, 메시지에서 접속 정보를 지운다', () => {
    expect(
      toMysqlTargetError(
        myError({ code: 'ER_LOCK_DEADLOCK', errno: 1213 }, 'Deadlock found'),
        info,
      ),
    ).toMatchObject({ code: 'TARGET_ERROR', retryable: true, driverCode: 'ER_LOCK_DEADLOCK' });
    const auth = toMysqlTargetError(
      myError(
        { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 },
        "Access denied for user 'quartz_app'@'my-prod.corp.example' (using password: YES) scheduler Sup3r-secret 3306",
      ),
      info,
    );
    expect(auth.detail).not.toMatch(/quartz_app|my-prod|scheduler|Sup3r-secret|3306/);
  });
});
