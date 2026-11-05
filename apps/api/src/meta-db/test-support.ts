import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 테스트마다 비어 있는 데이터 디렉터리를 만들고, cleanup으로 지운다 */
export function tempDataDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qa-meta-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
