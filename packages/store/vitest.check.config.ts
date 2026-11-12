import { defineConfig } from 'vitest/config';

/** 사내 Oracle 구버전 점검 (B-35, `pnpm check:oracle`). Docker가 필요하다(샌드박스와 로컬 검증). CI에서는 돌리지 않는다 */
export default defineConfig({
  test: {
    include: ['test/check/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
  },
});
