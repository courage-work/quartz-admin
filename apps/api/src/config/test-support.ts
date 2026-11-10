import { randomBytes } from 'node:crypto';
import type { AppConfig } from './env.js';

/** 테스트용 설정. 키는 매번 새로 만든다 */
export function testConfig(overrides: Partial<AppConfig> & Pick<AppConfig, 'dataDir'>): AppConfig {
  return {
    port: 0,
    publicUrl: 'http://localhost:3000',
    publicOrigin: 'http://localhost:3000',
    trustProxy: false,
    sessionIdleMin: 30,
    auditRetentionDays: 365,
    alertRetentionDays: 90,
    monitorConcurrency: 8,
    logLevel: 'info',
    webDev: false,
    encryption: { keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' },
    ...overrides,
  };
}

export function testKey(): string {
  return randomBytes(32).toString('base64');
}
