import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS DI에 필요한 데코레이터 메타데이터(emitDecoratorMetadata)를 SWC로 생성한다
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
