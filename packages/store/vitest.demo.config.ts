import { defineConfig } from 'vitest/config';

/** 손으로 확인할 때 쓰는 테스트베드 (`pnpm testbed:up`). Docker가 필요하다. CI에서는 돌리지 않는다 */
export default defineConfig({
  test: {
    include: ['test/demo/**/*.test.ts'],
    environment: 'node',
    testTimeout: 24 * 60 * 60_000,
    hookTimeout: 900_000,
  },
});
