import { defineConfig, devices } from '@playwright/test';

/** 앱을 띄울 포트. 개발 서버(3000)와 겹치지 않게 둔다 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * E2E (B-33, TRD §12, NFR-COMP-04). 같은 흐름을 Chrome, Edge, Safari(WebKit)에서 돌린다.
 * 세 브라우저가 같은 테스트베드 트리거를 제어하므로 워커 하나로 차례로 돌린다.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
