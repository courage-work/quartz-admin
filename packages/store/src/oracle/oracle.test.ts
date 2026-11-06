import { describe, expect, it } from 'vitest';
import type { TargetConnectInfo } from '../adapter.js';
import { oracleConnectString } from './connect-string.js';
import { oracleDialect } from './dialect.js';
import { toOracleTargetError } from './errors.js';

const info: TargetConnectInfo = {
  kind: 'oracle',
  host: 'db-prod.corp.example',
  port: 1521,
  username: 'QUARTZ_APP',
  password: 'Sup3r-secret',
  oracleServiceName: 'ORCLPDB1',
};

describe('oracleConnectString', () => {
  it('서비스 이름은 Easy Connect로 만든다', () => {
    expect(oracleConnectString(info)).toBe('db-prod.corp.example:1521/ORCLPDB1');
    expect(oracleConnectString({ ...info, host: '::1' })).toBe('[::1]:1521/ORCLPDB1');
  });

  it('SID는 접속 기술자로 만든다', () => {
    expect(oracleConnectString({ ...info, oracleServiceName: undefined, oracleSid: 'XE' })).toBe(
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db-prod.corp.example)(PORT=1521))(CONNECT_DATA=(SID=XE)))',
    );
  });

  it('서비스 이름과 SID는 둘 중 하나만 있어야 한다', () => {
    expect(() => oracleConnectString({ ...info, oracleSid: 'XE' })).toThrow('하나만');
    expect(() => oracleConnectString({ ...info, oracleServiceName: undefined })).toThrow('하나만');
  });

  it('접속 기술자를 깨뜨리는 값을 거부한다', () => {
    expect(() => oracleConnectString({ ...info, host: 'a)(HOST=evil' })).toThrow('호스트');
    expect(() => oracleConnectString({ ...info, port: 0 })).toThrow('포트');
    expect(() =>
      oracleConnectString({ ...info, oracleServiceName: undefined, oracleSid: 'X)(Y=1' }),
    ).toThrow('SID');
  });
});

describe('oracleDialect', () => {
  it('바인드, 식별자, 페이지네이션, 잠금 절 (TRD §5.3)', () => {
    expect(oracleDialect.param(3)).toBe(':p3');
    expect(() => oracleDialect.param(0)).toThrow(RangeError);
    expect(oracleDialect.quote('QRTZ_TRIGGERS')).toBe('"QRTZ_TRIGGERS"');
    expect(oracleDialect.quote('qrtz_triggers')).toBe('"qrtz_triggers"');
    expect(() => oracleDialect.quote('a"b')).toThrow();
    expect(oracleDialect.paginate('SELECT 1 FROM DUAL ORDER BY 1', 2, 3)).toBe(
      'SELECT 1 FROM DUAL ORDER BY 1 OFFSET :p3 ROWS FETCH NEXT :p2 ROWS ONLY',
    );
    expect(oracleDialect.forUpdate(5)).toBe('FOR UPDATE WAIT 5');
    expect(() => oracleDialect.forUpdate(-1)).toThrow(RangeError);
  });

  it('현재 시각 SQL은 12.1 문법만 쓴다', () => {
    const sql = oracleDialect.dbNowMillisSql();
    expect(sql).toContain('SYS_EXTRACT_UTC(SYSTIMESTAMP)');
    expect(sql).not.toMatch(/FETCH FIRST|JSON|BOOLEAN/);
  });
});

describe('toOracleTargetError', () => {
  const cases: [string, string, string][] = [
    [
      'ORA-01017',
      'ORA-01017: invalid credential or not authorized; logon denied',
      'TARGET_AUTH_FAILED',
    ],
    ['ORA-28000', 'ORA-28000: The account is locked.', 'TARGET_AUTH_FAILED'],
    [
      'NJS-503',
      'NJS-503: connection to host db-prod.corp.example port 1521 could not be established. (CONNECTION_ID=x)\nconnect ECONNREFUSED 10.0.0.5:1521',
      'TARGET_UNREACHABLE',
    ],
    [
      'NJS-518',
      'NJS-518: cannot connect to Oracle Database. Service "ORCLPDB1" is not registered with the listener at host db-prod.corp.example port 1521. (CONNECTION_ID=x)',
      'TARGET_UNREACHABLE',
    ],
    [
      'NJS-500',
      'NJS-500: connection to Oracle Database was closed or broken',
      'TARGET_UNREACHABLE',
    ],
    [
      'NJS-510',
      'NJS-510: connection to host db-prod.corp.example port 1521 timed out. Request exceeded "connectTimeout" of 10 seconds.',
      'TARGET_TIMEOUT',
    ],
    ['NJS-123', 'NJS-123: call timeout of 10000 ms exceeded', 'TARGET_TIMEOUT'],
    ['ORA-30006', 'ORA-30006: resource busy; acquire with WAIT timeout expired', 'LOCK_TIMEOUT'],
    ['ORA-00942', 'ORA-00942: table or view "QUARTZ_APP"."QRTZ_X" does not exist', 'TARGET_ERROR'],
  ];

  it.each(cases)('%s → 도구 오류 코드', (code, message, expected) => {
    const err = toOracleTargetError(Object.assign(new Error(message), { code }), info);
    expect(err.code).toBe(expected);
    expect(err.driverCode).toBe(code);
  });

  it('메시지에서 접속 정보를 지운다', () => {
    for (const [code, message] of cases) {
      const err = toOracleTargetError(Object.assign(new Error(message), { code }), info);
      const text = `${err.message} ${err.detail ?? ''}`;
      for (const secret of [
        'db-prod',
        'ORCLPDB1',
        'QUARTZ_APP',
        'Sup3r-secret',
        '10.0.0.5',
        ':1521',
        'port 1521',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('교착(ORA-00060)은 재시도 가능한 TARGET_ERROR', () => {
    const err = toOracleTargetError(
      Object.assign(new Error('ORA-00060: deadlock detected while waiting for resource'), {
        code: 'ORA-00060',
      }),
      info,
    );
    expect(err).toMatchObject({ code: 'TARGET_ERROR', retryable: true });
  });

  it('code 속성이 없으면 메시지 앞의 코드로, Node 소켓 오류는 errno 코드로 분류한다', () => {
    expect(toOracleTargetError(new Error('ORA-01017: logon denied'), info).code).toBe(
      'TARGET_AUTH_FAILED',
    );
    expect(
      toOracleTargetError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        info,
      ).code,
    ).toBe('TARGET_UNREACHABLE');
  });
});
