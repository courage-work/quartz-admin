// 웹 정적 export 결과물(apps/web/out)을 apps/api/public으로 복사한다 (TRD §2.1)
// 웹을 빌드하지 않았으면 경고만 하고 넘어간다. 이때 API는 화면 없이 기동한다
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../web/out', import.meta.url));
const dest = fileURLToPath(new URL('../public', import.meta.url));

rmSync(dest, { recursive: true, force: true });
if (!existsSync(src)) {
  console.warn(`[copy-web] ${src}가 없어 화면 파일을 복사하지 않았습니다`);
} else {
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-web] ${src} → ${dest}`);
}
