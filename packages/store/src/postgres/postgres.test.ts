import { describe, expect, it } from 'vitest';
import type { TargetConn, TargetConnectInfo } from '../adapter.js';
import { TargetError } from '../errors.js';
import { postgresDialect } from './dialect.js';
import { toPostgresTargetError } from './errors.js';

const info: TargetConnectInfo = {
  kind: 'postgresql',
  host: 'pg-prod.corp.example',
  port: 5432,
  username: 'quartz_app',
  password: 'Sup3r-secret',
  database: 'scheduler',
};

/** pg 오류처럼 생긴 값 */
function pgError(code: string | undefined, message: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe('postgresDialect', () => {
  it('바인드, 식별자, 페이지네이션, 잠금 절 (TRD §5.3)', () => {
    expect(postgresDialect.param(3)).toBe('$3');
    expect(() => postgresDialect.param(0)).toThrow(RangeError);
    expect(postgresDialect.quote('qrtz_triggers')).toBe('"qrtz_triggers"');
    expect(() => postgresDialect.quote('a"b')).toThrow();
    expect(postgresDialect.paginate('SELECT 1 ORDER BY 1', 2, 3)).toBe(
      'SELECT 1 ORDER BY 1 LIMIT $2 OFFSET $3',
    );
    // 대기 제한은 SET LOCAL lock_timeout이 맡는다
    expect(postgresDialect.forUpdate(5)).toBe('FOR UPDATE');
  });

  it('잠금 트랜잭션 앞에서 그 트랜잭션에만 잠금 대기 제한을 건다', async () => {
    const executed: string[] = [];
    const conn = {
      execute: (sql: string) => {
        executed.push(sql);
        return Promise.resolve(0);
      },
    } as unknown as TargetConn;
    await postgresDialect.beforeLockedTx(conn, 5);
    await postgresDialect.afterLockedTx(conn);
    expect(executed).toEqual([`SET LOCAL lock_timeout = '5s'`]);
    await expect(postgresDialect.beforeLockedTx(conn, 1.5)).rejects.toThrow(RangeError);
  });

  it('현재 시각은 트랜잭션 시작 시각이 아닌 실제 시각, 카탈로그는 대문자 별칭', () => {
    expect(postgresDialect.dbNowMillisSql()).toContain('clock_timestamp()');
    expect(postgresDialect.catalog.tables).toContain('"TABLE_NAME"');
    expect(postgresDialect.catalog.columns).toContain('"DATA_TYPE"');
  });

  it('고유 제약 위반(23505)을 가려낸다', () => {
    expect(
      postgresDialect.isDuplicateKey(new TargetError('TARGET_ERROR', { driverCode: '23505' })),
    ).toBe(true);
    expect(
      postgresDialect.isDuplicateKey(new TargetError('TARGET_ERROR', { driverCode: '42501' })),
    ).toBe(false);
  });
});

describe('toPostgresTargetError', () => {
  it.each([
    ['28P01', 'password authentication failed for user "quartz_app"', 'TARGET_AUTH_FAILED'],
    ['28000', 'no pg_hba.conf entry for host "10.0.0.5"', 'TARGET_AUTH_FAILED'],
    ['3D000', 'database "scheduler" does not exist', 'TARGET_UNREACHABLE'],
    ['08006', 'connection failure', 'TARGET_UNREACHABLE'],
    ['57P01', 'terminating connection due to administrator command', 'TARGET_UNREACHABLE'],
    ['57014', 'canceling statement due to statement timeout', 'TARGET_TIMEOUT'],
    ['55P03', 'canceling statement due to lock timeout', 'LOCK_TIMEOUT'],
    ['42501', 'permission denied for table qrtz_triggers', 'TARGET_ERROR'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:5432', 'TARGET_UNREACHABLE'],
    [undefined, 'Connection terminated due to connection timeout', 'TARGET_TIMEOUT'],
    [undefined, 'Query read timeout', 'TARGET_TIMEOUT'],
    [undefined, 'Connection terminated unexpectedly', 'TARGET_UNREACHABLE'],
  ] as const)('%s → %s', (code, message, expected) => {
    expect(toPostgresTargetError(pgError(code, message), info).code).toBe(expected);
  });

  it('교착(40P01)은 다시 시도할 수 있고, 메시지에서 접속 정보를 지운다', () => {
    const deadlock = toPostgresTargetError(pgError('40P01', 'deadlock detected'), info);
    expect(deadlock).toMatchObject({ code: 'TARGET_ERROR', retryable: true, driverCode: '40P01' });
    const auth = toPostgresTargetError(
      pgError(
        '28P01',
        'password authentication failed for user "quartz_app" on pg-prod.corp.example:5432 db scheduler Sup3r-secret',
      ),
      info,
    );
    expect(auth.detail).not.toMatch(/quartz_app|pg-prod|scheduler|Sup3r-secret|5432/);
    expect(auth.message).not.toContain('quartz_app');
  });
});
