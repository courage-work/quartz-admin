import { createConnectionRequestSchema, updateConnectionRequestSchema } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import { describeTarget } from './audit';
import {
  connectionFormValues,
  describeAddress,
  EMPTY_CONNECTION_FORM,
  formatDuration,
  formFieldOf,
  toConnectionRequest,
  writeStatus,
} from './connections';

const filled = {
  ...EMPTY_CONNECTION_FORM,
  name: '정산 운영',
  host: 'db.corp',
  oracleName: 'ORCLPDB1',
  username: 'quartz',
  password: 'pw',
  envLabel: 'prod',
  tags: ' 정산, 배치 ,,',
};

describe('toConnectionRequest', () => {
  it('Oracle 접속 방식에 따라 서비스 이름이나 SID 한쪽만 채운다', () => {
    expect(toConnectionRequest(filled)).toMatchObject({
      port: 1521,
      oracleServiceName: 'ORCLPDB1',
      oracleSid: '',
      database: '',
      tags: ['정산', '배치'],
    });
    expect(toConnectionRequest({ ...filled, oracleMode: 'sid', oracleName: 'XE' })).toMatchObject({
      oracleServiceName: '',
      oracleSid: 'XE',
    });
  });

  it('서버와 같은 스키마로 검사된다', () => {
    expect(createConnectionRequestSchema.safeParse(toConnectionRequest(filled)).success).toBe(true);
    const noName = createConnectionRequestSchema.safeParse(
      toConnectionRequest({ ...filled, oracleName: '' }),
    );
    expect(noName.success).toBe(false);
    expect(noName.error?.issues.map((i) => formFieldOf(i.path.join('.')))).toContain('oracleName');
    // 포트를 비우면 숫자가 아니므로 거부된다
    const noPort = createConnectionRequestSchema.safeParse(
      toConnectionRequest({ ...filled, port: '' }),
    );
    expect(noPort.error?.issues.map((i) => formFieldOf(i.path.join('.')))).toContain('port');
  });

  it('수정 폼은 비밀번호를 비워 보내면 기존 값을 쓰도록 통과한다', () => {
    const values = connectionFormValues({
      id: 1,
      name: 'a',
      dbType: 'oracle',
      host: 'h',
      port: 1522,
      database: null,
      oracleServiceName: null,
      oracleSid: 'XE',
      schemaName: null,
      username: 'u',
      envLabel: 'dev',
      tags: ['x'],
      readOnly: true,
      writeCapable: null,
      schedulerCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(values).toMatchObject({
      password: '',
      oracleMode: 'sid',
      oracleName: 'XE',
      port: '1522',
      tags: 'x',
    });
    const parsed = updateConnectionRequestSchema.safeParse(toConnectionRequest(values));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.password).toBeUndefined();
  });
});

describe('표시 도우미', () => {
  it('주소를 접속 방식에 맞게 보여 준다', () => {
    const base = {
      host: 'db',
      port: 1521,
      database: null,
      oracleServiceName: null,
      oracleSid: null,
    };
    expect(describeAddress({ ...base, oracleServiceName: 'PDB1' })).toBe('db:1521/PDB1');
    expect(describeAddress({ ...base, oracleSid: 'XE' })).toBe('db:1521:XE');
    expect(describeAddress({ ...base, host: '::1', database: 'q' })).toBe('[::1]:1521/q');
  });

  it('사용자 지정 읽기 전용이 감지 결과보다 먼저다', () => {
    expect(writeStatus({ readOnly: true, writeCapable: true }).label).toBe('읽기 전용(지정)');
    expect(writeStatus({ readOnly: false, writeCapable: null }).label).toBe('감지 전');
    expect(writeStatus({ readOnly: false, writeCapable: false }).tone).toBe('warning');
    expect(writeStatus({ readOnly: false, writeCapable: true }).tone).toBe('success');
  });

  it('시간을 분·초 단위로 줄여 보여 준다', () => {
    expect(formatDuration(60_000)).toBe('1분');
    expect(formatDuration(30_000)).toBe('30초');
    expect(formatDuration(1_500)).toBe('1500ms');
  });

  it('감사 로그 대상에 접속 이름과 스케줄러 이름을 보여 준다', () => {
    expect(describeTarget({ targetType: 'connection', target: { id: 1, name: '정산' } })).toBe(
      '정산',
    );
    expect(
      describeTarget({
        targetType: 'scheduler',
        target: { connectionId: 1, schedulers: [{ displayName: 'A' }, { schedName: 'B' }] },
      }),
    ).toBe('A, B');
    expect(describeTarget({ targetType: 'scheduler', target: { id: 4 } })).toBe('#4');
  });
});
