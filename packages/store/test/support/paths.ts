import { fileURLToPath } from 'node:url';

/** 레포 루트의 `tools/quartz-testbed` 디렉터리 */
export const TESTBED_DIR = fileURLToPath(
  new URL('../../../../tools/quartz-testbed/', import.meta.url),
);
