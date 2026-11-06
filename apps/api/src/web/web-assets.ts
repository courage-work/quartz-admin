import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { HEALTH_PATHS } from '../health/paths.js';

/** `apps/api/public`. 빌드 시 웹 정적 export 결과물을 복사해 둔다 (`scripts/copy-web.mjs`) */
export function defaultWebDir(): string {
  // dist/web/web-assets.js 기준 두 단계 위
  return fileURLToPath(new URL('../../public', import.meta.url));
}

/** `src`가 없는 인라인 스크립트. Next.js 정적 export는 HTML마다 RSC 페이로드 등을 인라인으로 넣는다 */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const body = m[1] ?? '';
    if (body.length === 0) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

/**
 * 화면 HTML용 CSP. helmet 기본값에서 `script-src`에 그 파일의 인라인 스크립트 해시만 더한다(TRD §4.3).
 * `'unsafe-inline'`은 쓰지 않는다.
 * http로 서비스하면 `upgrade-insecure-requests`를 뺀다. 사내망 http 주소에서 정적 파일 요청이 https로 바뀌어 깨지기 때문이다.
 */
export function htmlCsp(hashes: string[], https: boolean): string {
  const directives: Record<string, Iterable<string>> = {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    'script-src': ["'self'", ...hashes],
  };
  if (!https) delete directives['upgrade-insecure-requests'];
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(' '))
    .join('; ');
}

interface HtmlPage {
  file: string;
  csp: string;
}

/**
 * 웹 정적 파일 목록. 기동할 때 한 번 읽어 HTML마다 CSP를 미리 만든다.
 * 파일은 빌드 결과물이라 실행 중에 바뀌지 않는다.
 */
export class WebAssets {
  readonly root: string;
  private readonly pages = new Map<string, HtmlPage>();
  private readonly files = new Set<string>();

  constructor(root: string, https: boolean) {
    this.root = resolve(root);
    for (const rel of listFiles(this.root)) {
      const key = rel.split(sep).join('/');
      this.files.add(key);
      if (key.endsWith('.html')) {
        const file = join(this.root, rel);
        this.pages.set(key, {
          file,
          csp: htmlCsp(inlineScriptHashes(readFileSync(file, 'utf8')), https),
        });
      }
    }
  }

  static load(root: string | null | undefined, https: boolean): WebAssets | null {
    if (!root || !existsSync(join(root, 'index.html'))) return null;
    return new WebAssets(root, https);
  }

  /**
   * 요청 경로에 맞는 파일을 찾는다. 순서: 파일 그대로 → `<경로>.html` → `<경로>/index.html`.
   * 없으면 null(호출자가 404.html을 보낸다).
   */
  resolve(urlPath: string): string | null {
    let path: string;
    try {
      path = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (path.includes('\0')) return null;
    const key = path.replace(/^\/+/, '').replace(/\/+$/, '');
    // 상위 디렉터리 이동은 목록에 없으므로 자연히 걸러지지만, 경로 정규화 결과도 한 번 더 확인한다
    if (key.split('/').some((part) => part === '..' || part === '.')) return null;
    for (const candidate of key === ''
      ? ['index.html']
      : [key, `${key}.html`, `${key}/index.html`]) {
      if (this.files.has(candidate)) return candidate;
    }
    return null;
  }

  pathOf(key: string): string {
    return join(this.root, ...key.split('/'));
  }

  page(key: string): HtmlPage | undefined {
    return this.pages.get(key);
  }
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

/** 해시가 붙은 빌드 산출물. 내용이 바뀌면 이름도 바뀌므로 오래 캐시한다 */
const IMMUTABLE = /^_next\/static\//;

/**
 * `/api` 이외의 GET/HEAD 요청에 화면 파일을 돌려준다 (TRD §2.2).
 * 정적 export는 `/x?id=1` 같은 쿼리 기반 경로를 쓰므로 `/x` → `x.html`로 이어 준다.
 * 없는 경로는 `404.html`을 404로 보낸다. `/api` 경로와 다른 메서드는 Nest로 넘긴다.
 */
export function webAssetsMiddleware(assets: WebAssets, apiPrefix: string) {
  const apiRoot = `/${apiPrefix.split('/')[0]}`;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === apiRoot || req.path.startsWith(`${apiRoot}/`)) return next();
    if (HEALTH_PATHS.includes(req.path)) return next();

    const key = assets.resolve(req.path);
    const target = key ?? (assets.resolve('/404.html') ? '404.html' : null);
    if (!target) return next();

    const page = assets.page(target);
    if (page) {
      res.setHeader('Content-Security-Policy', page.csp);
      // 새 배포가 바로 반영되도록 HTML은 매번 확인한다
      res.setHeader('Cache-Control', 'no-cache');
    } else if (IMMUTABLE.test(target)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    if (!key) res.status(404);
    res.sendFile(assets.pathOf(target), { dotfiles: 'allow', lastModified: true }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  };
}
