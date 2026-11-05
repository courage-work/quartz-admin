import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/support의 순수 로직 테스트도 단위 테스트로 돈다. Docker가 필요한 테스트는 test/integration에 둔다
    include: ['src/**/*.test.ts', 'test/support/**/*.test.ts'],
    environment: 'node',
  },
});
