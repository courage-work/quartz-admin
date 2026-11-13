import { mkdirSync } from 'node:fs';
import { E2E_PORT } from './playwright.config.js';
import { RUN_DIR, startApp, startTestbed } from './support/stack.js';

/**
 * 테스트베드와 앱을 띄우고, 테스트가 쓸 값을 환경 변수로 넘긴다(Playwright는 전역 준비에서 바꾼 환경 변수를
 * 워커에 넘긴다). 돌려준 함수가 정리 단계다.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(RUN_DIR, { recursive: true });
  const testbed = await startTestbed();
  let app;
  try {
    app = await startApp(E2E_PORT);
  } catch (err) {
    await testbed.stop();
    throw err;
  }
  process.env.E2E_ADMIN_USERNAME = app.admin.username;
  process.env.E2E_ADMIN_PASSWORD = app.admin.password;
  process.env.E2E_TESTBED = JSON.stringify(testbed.info);
  const started = app;
  return async () => {
    await started.stop();
    await testbed.stop();
  };
}
