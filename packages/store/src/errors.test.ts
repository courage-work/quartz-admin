import { describe, expect, it } from 'vitest';
import { TargetError, redactConnectionInfo } from './errors.js';

describe('redactConnectionInfo', () => {
  const values = {
    host: 'db-prod.corp.example',
    port: 1521,
    username: 'QUARTZ_APP',
    password: 'p@ss:w0rd',
    names: ['ORCLPDB1', undefined],
  };

  it('알려준 접속 값을 대소문자 구분 없이 지운다', () => {
    const out = redactConnectionInfo(
      'login quartz_app with p@ss:w0rd to db-prod.corp.example/orclpdb1 failed',
      values,
    );
    expect(out).toBe('login *** with *** to ***/*** failed');
  });

  it('oracledb 메시지 형식(host X port N, CONNECTION_ID)을 지운다', () => {
    const out = redactConnectionInfo(
      'NJS-503: connection to host 10.1.2.3 port 1521 could not be established. (CONNECTION_ID=abc+/==)',
    );
    expect(out).toBe(
      'NJS-503: connection to host *** port *** could not be established. (CONNECTION_ID=***)',
    );
  });

  it('접속 기술자의 HOST, PORT, SERVICE_NAME, SID를 지운다', () => {
    const out = redactConnectionInfo(
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=other.host)(PORT=1599))(CONNECT_DATA=(SID=XE)))',
    );
    expect(out).toBe(
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=***)(PORT=***))(CONNECT_DATA=(SID=***)))',
    );
  });

  it('IP 주소, ENOTFOUND 호스트, 따옴표로 감싼 계정 이름을 지운다', () => {
    expect(redactConnectionInfo('connect ECONNREFUSED 192.168.0.10:5432')).toBe(
      'connect ECONNREFUSED ***',
    );
    expect(redactConnectionInfo('getaddrinfo ENOTFOUND unknown.db')).toBe(
      'getaddrinfo ENOTFOUND ***',
    );
    expect(redactConnectionInfo('password authentication failed for user "scott"')).toBe(
      'password authentication failed for user "***"',
    );
  });

  it('포트는 구분자 뒤에 올 때만 지워 오류 번호를 건드리지 않는다', () => {
    expect(redactConnectionInfo('ORA-01521 at :1521', { port: 1521 })).toBe('ORA-01521 at :***');
  });
});

describe('TargetError', () => {
  it('코드별 한국어 문구와 재시도 가능 여부를 정한다', () => {
    const busy = new TargetError('TARGET_BUSY');
    expect(busy.message).toContain('사용 중');
    expect(busy.retryable).toBe(true);
    expect(new TargetError('TARGET_AUTH_FAILED').retryable).toBe(false);
    expect(new TargetError('TARGET_ERROR', { retryable: true }).retryable).toBe(true);
  });

  it('끊긴 커넥션 오류를 구분한다', () => {
    expect(new TargetError('TARGET_UNREACHABLE').connectionBroken).toBe(true);
    expect(new TargetError('TARGET_TIMEOUT').connectionBroken).toBe(true);
    expect(new TargetError('LOCK_TIMEOUT').connectionBroken).toBe(false);
  });

  it('JSON에는 원래 드라이버 오류가 들어가지 않는다', () => {
    const err = new TargetError('TARGET_ERROR', {
      driverCode: 'ORA-00942',
      detail: 'table missing',
    });
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: 'TargetError',
      code: 'TARGET_ERROR',
      message: '대상 DB에서 오류가 발생했습니다',
      driverCode: 'ORA-00942',
      detail: 'table missing',
      retryable: false,
    });
    expect(err.cause).toBeUndefined();
  });
});
