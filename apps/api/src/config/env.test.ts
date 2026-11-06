import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadDataDir } from './env.js';
import { testKey } from './test-support.js';

const K1 = testKey();
const K2 = testKey();

const base = {
  QA_ENCRYPTION_KEYS: `k1:${K1}`,
  QA_ENCRYPTION_ACTIVE_KEY: 'k1',
  QA_PUBLIC_URL: 'https://quartz-admin.example.com/',
};

function issuesOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('ConfigError가 나지 않았습니다');
}

describe('loadConfig', () => {
  it('필수값만 있으면 TRD §11.2 기본값으로 설정을 만든다', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      dataDir: '/data',
      port: 3000,
      publicUrl: 'https://quartz-admin.example.com',
      publicOrigin: 'https://quartz-admin.example.com',
      trustProxy: false,
      sessionIdleMin: 30,
      auditRetentionDays: 365,
      alertRetentionDays: 90,
      monitorConcurrency: 8,
      logLevel: 'info',
    });
    expect(config.encryption.activeKeyId).toBe('k1');
    expect(config.encryption.keys.get('k1')).toEqual(Buffer.from(K1, 'base64'));
    expect(config.admin).toBeUndefined();
    expect(config.smtp).toBeUndefined();
  });

  it('숫자·불리언을 변환하고, 빈 문자열은 지정하지 않은 것으로 본다', () => {
    const config = loadConfig({
      ...base,
      PORT: '8080',
      QA_TRUST_PROXY: '1',
      QA_SESSION_IDLE_MIN: '',
      QA_ENCRYPTION_KEYS: `k1:${K1}, k2:${K2}`,
      QA_ENCRYPTION_ACTIVE_KEY: 'k2',
    });
    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(true);
    expect(config.sessionIdleMin).toBe(30);
    expect([...config.encryption.keys.keys()]).toEqual(['k1', 'k2']);
  });

  it('키가 없으면 기동하지 않고 생성 방법을 안내한다', () => {
    const issues = issuesOf({ QA_PUBLIC_URL: base.QA_PUBLIC_URL });
    expect(issues).toContainEqual(
      expect.stringMatching(/^QA_ENCRYPTION_KEYS: 필수값입니다.*gen-key/),
    );
    expect(issues).toContainEqual(expect.stringMatching(/^QA_ENCRYPTION_ACTIVE_KEY: 필수값입니다/));
  });

  it('키 길이가 32바이트가 아니면 거부한다', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(issuesOf({ ...base, QA_ENCRYPTION_KEYS: `k1:${short}` })).toContainEqual(
      expect.stringContaining('키 "k1"는 32바이트여야 합니다(현재 16바이트)'),
    );
  });

  it('형식 오류, 잘못된 base64, 중복 ID, 없는 활성 키를 각각 알려준다', () => {
    expect(issuesOf({ ...base, QA_ENCRYPTION_KEYS: K1 })).toContainEqual(
      expect.stringContaining('1번째 항목이 "<키ID>:<base64>" 형식이 아닙니다'),
    );
    expect(issuesOf({ ...base, QA_ENCRYPTION_KEYS: 'k1:not*base64!' })).toContainEqual(
      expect.stringContaining('올바른 base64가 아닙니다'),
    );
    expect(issuesOf({ ...base, QA_ENCRYPTION_KEYS: `k1:${K1},k1:${K2}` })).toContainEqual(
      expect.stringContaining('키 ID "k1"가 중복됩니다'),
    );
    expect(issuesOf({ ...base, QA_ENCRYPTION_ACTIVE_KEY: 'k9' })).toEqual([
      'QA_ENCRYPTION_ACTIVE_KEY: QA_ENCRYPTION_KEYS에 없는 키 ID입니다',
    ]);
  });

  it('오류 메시지에 키 값을 넣지 않는다', () => {
    const short = Buffer.alloc(16, 7).toString('base64');
    const message = (() => {
      try {
        loadConfig({ ...base, QA_ENCRYPTION_KEYS: `k1:${short},k1:${K1}`, PORT: 'x' });
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    expect(message).not.toContain(short);
    expect(message).not.toContain(K1);
    expect(message).toContain('PORT: 숫자여야 합니다');
  });

  it('URL, 숫자 범위, 로그 수준을 검증한다', () => {
    const issues = issuesOf({
      ...base,
      QA_PUBLIC_URL: 'ftp://example.com',
      PORT: '70000',
      QA_LOG_LEVEL: 'verbose',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^QA_PUBLIC_URL: http/),
        'PORT: 65535 이하여야 합니다',
        expect.stringMatching(/^QA_LOG_LEVEL: fatal, error/),
      ]),
    );
  });

  it('관리자 계정은 아이디와 비밀번호를 함께 받는다', () => {
    expect(issuesOf({ ...base, QA_ADMIN_USERNAME: 'admin' })).toEqual([
      'QA_ADMIN_PASSWORD: QA_ADMIN_USERNAME과 QA_ADMIN_PASSWORD는 함께 지정해야 합니다',
    ]);
    expect(
      loadConfig({ ...base, QA_ADMIN_USERNAME: ' Admin ', QA_ADMIN_PASSWORD: 'long-enough' }).admin,
    ).toEqual({ username: 'admin', password: 'long-enough' });
  });

  it('초기 관리자에도 화면과 같은 아이디·비밀번호 규칙을 적용한다', () => {
    expect(issuesOf({ ...base, QA_ADMIN_USERNAME: 'a!', QA_ADMIN_PASSWORD: 'short' })).toEqual([
      'QA_ADMIN_USERNAME: 아이디는 영문, 숫자, ., _, @, -로 된 3~64자여야 합니다',
      'QA_ADMIN_PASSWORD: 비밀번호는 8자 이상이어야 합니다',
    ]);
  });

  it('SMTP 변수를 하나라도 쓰면 호스트와 발신 주소가 필요하다', () => {
    expect(issuesOf({ ...base, QA_SMTP_USER: 'mailer' })).toEqual([
      'QA_SMTP_HOST: 이메일 발송을 쓰려면 필수입니다',
      'QA_SMTP_FROM: 이메일 발송을 쓰려면 필수입니다',
    ]);
    expect(
      loadConfig({ ...base, QA_SMTP_HOST: 'smtp.internal', QA_SMTP_FROM: 'qa@example.com' }).smtp,
    ).toEqual({ host: 'smtp.internal', port: 587, from: 'qa@example.com', secure: false });
  });
});

describe('loadDataDir', () => {
  it('암호화 키 없이 데이터 디렉터리만 읽는다', () => {
    expect(loadDataDir({})).toBe('/data');
    expect(loadDataDir({ QA_DATA_DIR: '/srv/qa' })).toBe('/srv/qa');
  });
});
