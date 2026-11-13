import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * 손으로 돌리는 측정 (`pnpm --filter @qa/api perf:audit-export`). 시간이 걸리고 수치가 기계마다 달라 CI 단위 테스트에서는
 * 돌리지 않는다. 힙을 정확히 재려고 `--expose-gc`로 띄운다
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['perf/**/*.perf.ts'],
    environment: 'node',
    pool: 'forks',
    execArgv: ['--expose-gc'],
    testTimeout: 600_000,
  },
});
