import { defineConfig } from 'vitest/config';

/** 성능·규모 검증 (B-31, `pnpm perf`). Docker와 빌드한 API가 필요하다. CI에서는 돌리지 않는다 */
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
  },
});
