import { type Page, expect, test } from '@playwright/test';
import type { TestbedInfo } from '../support/stack.js';

/**
 * 운영자 흐름 E2E (B-33, TRD §12): 로그인 → 접속 등록 → 트리거 일시정지/재개 → 잡 즉시 실행 → 알림 확인 → 정리.
 * 같은 페이지를 이어서 쓰며 차례로 돈다. 브라우저마다 접속 이름을 달리하고 끝에 지워 다음 브라우저가 처음부터 시작한다.
 * 테스트베드의 트리거는 `demo / every-10s`(10초 간격)와 `demo / every-minute`(매분)이다.
 */

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이 없습니다. playwright test(전역 준비)로 실행하세요`);
  return value;
};

const DB_LABELS: Record<TestbedInfo['dbType'], string> = {
  oracle: 'Oracle',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
};

test.describe.configure({ mode: 'serial' });

let page: Page;
let connectionName: string;
let schedulerUrl: string;
const testbed = (): TestbedInfo => JSON.parse(env('E2E_TESTBED')) as TestbedInfo;

test.beforeAll(async ({ browser }, testInfo) => {
  page = await browser.newPage();
  // 재시도하면 앞 시도에서 남은 접속과 이름이 겹치지 않게 시도 번호를 붙인다
  connectionName = `e2e-${testInfo.project.name}-${testInfo.retry}`;
});

test.afterAll(async () => {
  await page.close();
});

/** 이 글이 든 알림 토스트가 뜰 때까지 기다린다. 앞 토스트가 남아 있을 수 있어 첫 번째를 읽지 않는다 */
async function expectToast(text: string): Promise<void> {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
}

test('로그인: 틀린 비밀번호는 거부하고, 맞으면 대시보드로 간다', async () => {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(env('E2E_ADMIN_USERNAME'));
  await page.getByLabel('비밀번호').fill('wrong-password-123');
  await page.getByRole('button', { name: '로그인하기' }).click();
  await expect(page.getByText('아이디 또는 비밀번호가 맞지 않습니다')).toBeVisible();

  await page.getByLabel('비밀번호').fill(env('E2E_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: '로그인하기' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '대시보드' })).toBeVisible();
});

test('접속 등록: 연결 테스트 → 저장 → 감지 → 스케줄러 등록', async () => {
  const tb = testbed();
  await page.goto('/connections/new');
  await page.getByLabel('DB 종류').click();
  await page.getByRole('option', { name: DB_LABELS[tb.dbType], exact: true }).click();
  await page.getByLabel('호스트').fill(tb.host);
  await page.getByLabel('포트').fill(String(tb.port));
  if (tb.oracleServiceName) await page.getByLabel('서비스 이름').fill(tb.oracleServiceName);
  if (tb.database) await page.getByLabel('DB 이름').fill(tb.database);
  await page.getByLabel('계정').fill(tb.username);
  await page.getByLabel('비밀번호', { exact: true }).fill(tb.password);

  await page.getByRole('button', { name: '연결 테스트하기' }).click();
  await expect(page.getByText(/연결했습니다|연결에 성공/).first()).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('접속 이름').fill(connectionName);
  await page.getByLabel('환경 라벨').fill('dev');
  await page.getByRole('button', { name: '접속 추가하기' }).click();

  // 새 접속은 상세 화면을 열자마자 감지한다. 처음 등록이면 후보가 미리 골라져 있다
  await expect(page).toHaveURL(/\/connection\?id=\d+/);
  const register = page.getByRole('button', { name: /^선택한 스케줄러 등록하기/ });
  await expect(register).toBeEnabled({ timeout: 60_000 });
  await register.click();
  await expect(page.getByRole('link', { name: tb.schedulerName }).first()).toBeVisible();

  await page.goto('/');
  const card = page.getByRole('link', { name: tb.schedulerName }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/scheduler\?id=\d+/);
  schedulerUrl = page.url();
});

test('트리거 일시정지와 재개: 확인 대화상자를 거쳐 상태가 바뀐다', async () => {
  await page.goto(`${schedulerUrl}&tab=triggers`);
  const row = page.getByRole('row').filter({ hasText: 'every-10s' }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.getByRole('button', { name: 'every-10s 트리거 제어' }).click();
  await page.getByRole('menuitem', { name: '일시정지' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('트리거 일시정지')).toBeVisible();
  await dialog.getByRole('button', { name: '일시정지하기' }).click();
  await expectToast('every-10s 트리거를 일시정지했습니다');
  await expect(row.getByText('일시정지', { exact: true })).toBeVisible();

  await row.getByRole('button', { name: 'every-10s 트리거 제어' }).click();
  await page.getByRole('menuitem', { name: '재개' }).click();
  await dialog.getByRole('button', { name: '재개하기' }).click();
  await expectToast('every-10s 트리거를 재개했습니다');
  await expect(row.getByText('일시정지', { exact: true })).toHaveCount(0);
});

test('잡 즉시 실행: 실행하고 감사 로그에 남는다', async () => {
  await page.goto(`${schedulerUrl}&tab=jobs`);
  const row = page.getByRole('row').filter({ hasText: 'every-minute' }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: 'every-minute 잡 제어' }).click();
  await page.getByRole('menuitem', { name: '즉시 실행' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('잡 즉시 실행')).toBeVisible();
  await dialog.getByRole('button', { name: '실행하기' }).click();
  await expectToast('every-minute 잡을');

  await page.goto('/audit-logs');
  await expect(page.getByRole('row').filter({ hasText: '잡 즉시 실행' }).first()).toBeVisible();
});

test('알림 확인: 노드 이탈 알림이 열리면 알림 센터에서 확인한다', async () => {
  // 기대 노드 수를 실제(2)보다 크게, 감시 주기를 가장 짧게(15초) 두면 다음 회차에 노드 이탈 알림이 열린다
  await page.goto(schedulerUrl.replace('/scheduler?', '/scheduler/settings?'));
  await page.getByLabel('기대 노드 수').fill('3');
  await page.getByLabel('감시 주기(초)').fill('15');
  await page.getByRole('button', { name: '설정 저장하기' }).click();
  await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();

  await page.goto('/alerts');
  const item = page.getByRole('row').filter({ hasText: '노드' }).first();
  await expect(async () => {
    await page.reload();
    await expect(item).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000, intervals: [5_000] });
  await item.getByRole('button', { name: '확인하기' }).click();
  await expectToast('알림을 확인했습니다');
  await expect(item.getByText('확인 전')).toHaveCount(0);
});

test('정리: 만든 접속을 지운다', async () => {
  await page.goto('/connections');
  await page.getByRole('link', { name: connectionName }).click();
  await page.getByRole('button', { name: '삭제하기', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: `${connectionName} 삭제하기` }).click();
  await expect(page).toHaveURL(/\/connections$/);
  await expect(page.getByRole('link', { name: connectionName })).toHaveCount(0);
});
