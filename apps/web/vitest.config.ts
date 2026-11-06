import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 화면 없이 확인할 수 있는 로직(lib/)만 단위 테스트한다. 화면 흐름은 E2E(B-33)에서 본다
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // 날짜 경계 테스트가 실행 환경 타임존에 흔들리지 않게 고정한다
    env: { TZ: 'Asia/Seoul' },
  },
});
