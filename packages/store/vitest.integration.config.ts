import { defineConfig } from 'vitest/config';

/** Testcontainers 통합 테스트. `pnpm test:integration`으로 실행하며 Docker가 필요하다. */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // 파일마다 Oracle과 클러스터를 띄우므로 동시에 돌리지 않는다
    fileParallelism: false,
    testTimeout: 120_000,
    // 첫 실행은 이미지 내려받기와 테스트베드 빌드가 포함된다
    hookTimeout: 900_000,
  },
});
