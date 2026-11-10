/**
 * 환경변수 설정 (TRD §11.2)
 *
 * 기동 시 한 번 검증해 `AppConfig`로 만들고, 이후에는 DI로만 전달한다.
 * 오류 메시지에는 어떤 변수가 왜 잘못됐는지만 담고 값(특히 키)은 절대 넣지 않는다.
 */
import { passwordSchema, usernameSchema } from '@qa/shared';
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  dataDir: string;
  port: number;
  /** 끝의 `/`를 뺀 공개 URL. 알림 링크에 쓴다 */
  publicUrl: string;
  /** Origin 검사용 (`https://admin.example.com`) */
  publicOrigin: string;
  trustProxy: boolean;
  sessionIdleMin: number;
  auditRetentionDays: number;
  alertRetentionDays: number;
  monitorConcurrency: number;
  logLevel: LogLevel;
  /**
   * 개발 전용. 화면을 빌드 결과물 대신 Next 개발 서버(HMR)로 같은 포트에서 서빙한다(`pnpm dev:hmr`, TRD §2.2).
   * 운영 이미지에는 웹 소스가 없어 켤 수 없다
   */
  webDev: boolean;
  encryption: { keys: ReadonlyMap<string, Buffer>; activeKeyId: string };
  /** 최초 기동 시 관리자 생성용. 둘 다 있거나 둘 다 없어야 한다 */
  admin?: { username: string; password: string };
  smtp?: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    from: string;
    secure: boolean;
  };
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `환경변수 설정이 올바르지 않아 기동을 중단합니다:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const ENCRYPTION_KEY_BYTES = 32;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const GEN_KEY_HINT = '`node dist/cli.js gen-key`로 생성할 수 있습니다';

const int = (min: number, max: number) =>
  z.coerce
    .number({ error: '숫자여야 합니다' })
    .int({ error: '정수여야 합니다' })
    .min(min, { error: `${min} 이상이어야 합니다` })
    .max(max, { error: `${max} 이하여야 합니다` });

const bool = z.stringbool({ error: '1/0, true/false, yes/no, on/off 중 하나여야 합니다' });

const encryptionKeys = z
  .string({ error: `필수값입니다. ${GEN_KEY_HINT}` })
  .transform((raw, ctx) => {
    const keys = new Map<string, Buffer>();
    const entries = raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      ctx.addIssue({ code: 'custom', message: `키가 하나도 없습니다. ${GEN_KEY_HINT}` });
      return keys;
    }
    entries.forEach((entry, index) => {
      const sep = entry.indexOf(':');
      if (sep <= 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${index + 1}번째 항목이 "<키ID>:<base64>" 형식이 아닙니다`,
        });
        return;
      }
      const id = entry.slice(0, sep);
      const value = entry.slice(sep + 1);
      if (!KEY_ID_RE.test(id)) {
        ctx.addIssue({
          code: 'custom',
          message: `${index + 1}번째 키 ID는 영문, 숫자, _, -로 된 1~32자여야 합니다`,
        });
        return;
      }
      if (keys.has(id)) {
        ctx.addIssue({ code: 'custom', message: `키 ID "${id}"가 중복됩니다` });
        return;
      }
      const decoded = Buffer.from(value, 'base64');
      // Node의 base64 디코딩은 잘못된 문자를 조용히 버리므로 다시 인코딩해 비교한다
      if (decoded.toString('base64') !== value) {
        ctx.addIssue({ code: 'custom', message: `키 "${id}"의 값이 올바른 base64가 아닙니다` });
        return;
      }
      if (decoded.length !== ENCRYPTION_KEY_BYTES) {
        ctx.addIssue({
          code: 'custom',
          message: `키 "${id}"는 ${ENCRYPTION_KEY_BYTES}바이트여야 합니다(현재 ${decoded.length}바이트). ${GEN_KEY_HINT}`,
        });
        return;
      }
      keys.set(id, decoded);
    });
    return keys;
  });

const publicUrl = z
  .url({ protocol: /^https?$/, error: 'http:// 또는 https://로 시작하는 URL이어야 합니다' })
  .transform((v) => v.replace(/\/+$/, ''));

export const dataDirSchema = z.string().min(1).default('/data');

const envSchema = z
  .object({
    QA_ENCRYPTION_KEYS: encryptionKeys,
    QA_ENCRYPTION_ACTIVE_KEY: z.string({ error: '필수값입니다. 암호화에 쓸 키 ID를 지정하세요' }),
    QA_PUBLIC_URL: z
      .string({ error: '필수값입니다 (예: https://quartz-admin.example.com)' })
      .pipe(publicUrl),
    QA_DATA_DIR: dataDirSchema,
    PORT: int(1, 65_535).default(3000),
    QA_TRUST_PROXY: bool.default(false),
    QA_SESSION_IDLE_MIN: int(1, 24 * 60).default(30),
    QA_AUDIT_RETENTION_DAYS: int(1, 36_500).default(365),
    QA_ALERT_RETENTION_DAYS: int(1, 36_500).default(90),
    QA_MONITOR_CONCURRENCY: int(1, 64).default(8),
    QA_WEB_DEV: bool.default(false),
    QA_LOG_LEVEL: z
      .enum(LOG_LEVELS, { error: `${LOG_LEVELS.join(', ')} 중 하나여야 합니다` })
      .default('info'),
    // 화면에서 만드는 계정과 같은 규칙을 적용한다. 아이디는 소문자로 맞춘다
    QA_ADMIN_USERNAME: usernameSchema.optional(),
    QA_ADMIN_PASSWORD: passwordSchema.optional(),
    QA_SMTP_HOST: z.string().optional(),
    QA_SMTP_PORT: int(1, 65_535).optional(),
    QA_SMTP_USER: z.string().optional(),
    QA_SMTP_PASSWORD: z.string().optional(),
    QA_SMTP_FROM: z.string().optional(),
    QA_SMTP_SECURE: bool.optional(),
  })
  .superRefine((env, ctx) => {
    if (
      env.QA_ENCRYPTION_KEYS.size > 0 &&
      !env.QA_ENCRYPTION_KEYS.has(env.QA_ENCRYPTION_ACTIVE_KEY)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['QA_ENCRYPTION_ACTIVE_KEY'],
        message: 'QA_ENCRYPTION_KEYS에 없는 키 ID입니다',
      });
    }
    if (Boolean(env.QA_ADMIN_USERNAME) !== Boolean(env.QA_ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.QA_ADMIN_USERNAME ? 'QA_ADMIN_PASSWORD' : 'QA_ADMIN_USERNAME'],
        message: 'QA_ADMIN_USERNAME과 QA_ADMIN_PASSWORD는 함께 지정해야 합니다',
      });
    }
    const smtpUsed = Object.entries(env).some(
      ([k, v]) => k.startsWith('QA_SMTP_') && v !== undefined,
    );
    if (smtpUsed) {
      for (const key of ['QA_SMTP_HOST', 'QA_SMTP_FROM'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: '이메일 발송을 쓰려면 필수입니다' });
        }
      }
    }
  });

/** 빈 문자열은 지정하지 않은 것으로 본다(compose의 `VAR=` 같은 경우) */
function compact(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
  );
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(전체)'}: ${issue.message}`);
}

/** 환경변수를 검증해 설정을 만든다. 잘못되면 ConfigError */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(compact(env));
  if (!result.success) throw new ConfigError(formatIssues(result.error));
  const e = result.data;
  return {
    dataDir: e.QA_DATA_DIR,
    port: e.PORT,
    publicUrl: e.QA_PUBLIC_URL,
    publicOrigin: new URL(e.QA_PUBLIC_URL).origin,
    trustProxy: e.QA_TRUST_PROXY,
    sessionIdleMin: e.QA_SESSION_IDLE_MIN,
    auditRetentionDays: e.QA_AUDIT_RETENTION_DAYS,
    alertRetentionDays: e.QA_ALERT_RETENTION_DAYS,
    monitorConcurrency: e.QA_MONITOR_CONCURRENCY,
    logLevel: e.QA_LOG_LEVEL,
    webDev: e.QA_WEB_DEV,
    encryption: { keys: e.QA_ENCRYPTION_KEYS, activeKeyId: e.QA_ENCRYPTION_ACTIVE_KEY },
    ...(e.QA_ADMIN_USERNAME && e.QA_ADMIN_PASSWORD
      ? { admin: { username: e.QA_ADMIN_USERNAME, password: e.QA_ADMIN_PASSWORD } }
      : {}),
    ...(e.QA_SMTP_HOST && e.QA_SMTP_FROM
      ? {
          smtp: {
            host: e.QA_SMTP_HOST,
            port: e.QA_SMTP_PORT ?? 587,
            ...(e.QA_SMTP_USER ? { user: e.QA_SMTP_USER } : {}),
            ...(e.QA_SMTP_PASSWORD ? { password: e.QA_SMTP_PASSWORD } : {}),
            from: e.QA_SMTP_FROM,
            secure: e.QA_SMTP_SECURE ?? false,
          },
        }
      : {}),
  };
}

/** 암호화 키가 필요 없는 CLI(backup 등)용: 데이터 디렉터리만 읽는다 */
export function loadDataDir(env: NodeJS.ProcessEnv): string {
  const result = dataDirSchema.safeParse(compact(env).QA_DATA_DIR);
  if (!result.success) throw new ConfigError([`QA_DATA_DIR: ${result.error.issues[0]?.message}`]);
  return result.data;
}
