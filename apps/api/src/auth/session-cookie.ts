import type { CookieOptions, Request } from 'express';
import type { AppConfig } from '../config/env.js';
import { SESSION_COOKIE } from './policy.js';

/**
 * 세션 쿠키 속성 (TRD §4.2). `QA_PUBLIC_URL`이 `http://`인 로컬 개발 환경에서만 `Secure`를 끈다.
 * 만료 시각을 넣지 않은 세션 쿠키라 브라우저를 닫으면 사라지고, 실제 만료는 서버가 판정한다.
 */
export function sessionCookieOptions(config: Pick<AppConfig, 'publicUrl'>): CookieOptions {
  return {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'strict',
    path: '/',
  };
}

/** 쿠키 파서 미들웨어 없이 세션 쿠키 하나만 읽는다. 토큰은 base64url이라 디코딩이 필요 없다 */
export function readSessionToken(req: Pick<Request, 'headers'>): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  }
  return undefined;
}
