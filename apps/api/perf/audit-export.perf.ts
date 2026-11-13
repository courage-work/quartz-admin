import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp } from '../src/auth/test-support.js';
import { MetaDbService } from '../src/meta-db/meta-db.service.js';

/**
 * 감사 로그 CSV 내보내기 메모리 측정 (B-34, FR-AUD-05 완료 기준: 10만 건을 내보낼 때 메모리 사용량이 일정하다).
 *
 * 실제 포트로 띄운 API에서 1만 건과 10만 건을 내려받는다. 받는 쪽은 조각을 버리면서 바이트만 센다(supertest는 응답을 모아 두어
 * 같은 프로세스의 힙을 부풀리므로 쓰지 않는다). 내려받는 동안 100ms마다 GC를 돌린 뒤 힙을 재어(살아 있는 메모리),
 * 시작 전보다 늘어난 최대치를 본다. GC 없이 잰 최대치는 이미 쓴 묶음의 쓰레기까지 들어가므로 참고로만 남긴다.
 * 메모리가 일정하면 10만 건의 최대 증가량이 1만 건과 비슷하고 파일 크기보다 훨씬 작다.
 * 결과는 `perf-results/audit-export.json`(git 제외)에 남는다.
 */

const gc = (globalThis as { gc?: () => void }).gc;
const MB = 1024 * 1024;

let t: TestApp;
let base: string;
let cookie: string;

/** 실제 운영 기록과 비슷한 크기(대상·변경 전후 JSON 포함, 한 줄 약 600바이트) */
function seed(count: number): void {
  const sqlite = t.app.get(MetaDbService).sqlite;
  const insert = sqlite.prepare(
    `INSERT INTO audit_logs (at, username, ip, request_id, action, target_type, target, scheduler_id, before, after, result)
     VALUES (@at, @username, '10.0.0.1', @requestId, 'trigger.pause', 'trigger', @target, 1, @before, @after, 'success')`,
  );
  sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const trigger = { group: `group-${i % 50}`, name: `trigger-${String(i).padStart(6, '0')}` };
      insert.run({
        at: t.clock.now + i,
        username: `operator${i % 20}`,
        requestId: `req-${i.toString(36).padStart(10, '0')}`,
        target: JSON.stringify({ schedName: 'SettlementScheduler', trigger }),
        before: JSON.stringify({
          command: { type: 'pauseTrigger', trigger },
          expected: { triggers: [{ ...trigger, state: 'WAITING' }], pausedGroups: [] },
        }),
        after: JSON.stringify({
          triggers: [{ ...trigger, state: 'PAUSED' }],
          pausedGroups: [],
          changes: [{ ...trigger, from: 'WAITING', to: 'PAUSED' }],
          groupChanges: [],
        }),
      });
    }
  })();
}

interface Measured {
  rows: number;
  bytes: number;
  ms: number;
  /** GC 뒤 잰 힙(살아 있는 메모리)의 최대 증가량 */
  peakHeapDeltaMb: number;
  /** GC 없이 잰 힙의 최대 증가량(쓰레기 포함, 참고) */
  peakHeapNoGcDeltaMb: number;
  peakRssDeltaMb: number;
}

async function measure(query: string): Promise<Measured> {
  gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const rss0 = process.memoryUsage().rss;
  let peakHeap = heap0;
  let peakHeapNoGc = heap0;
  let peakRss = rss0;
  const timer = setInterval(() => {
    peakHeapNoGc = Math.max(peakHeapNoGc, process.memoryUsage().heapUsed);
    gc?.();
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakRss = Math.max(peakRss, m.rss);
  }, 100);
  const started = performance.now();
  const res = await fetch(`${base}/api/v1/audit-logs/export.csv${query}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  let bytes = 0;
  let newlines = 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    for (const b of value) if (b === 0x0a) newlines++;
  }
  clearInterval(timer);
  return {
    rows: newlines - 1,
    bytes,
    ms: Math.round(performance.now() - started),
    peakHeapDeltaMb: +((peakHeap - heap0) / MB).toFixed(1),
    peakHeapNoGcDeltaMb: +((peakHeapNoGc - heap0) / MB).toFixed(1),
    peakRssDeltaMb: +((peakRss - rss0) / MB).toFixed(1),
  };
}

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  cookie = await t.login(ADMIN.username, ADMIN.password);
  seed(100_000);
});

afterAll(async () => {
  await t?.close();
});

it('10만 건을 내보내도 힙 증가량이 1만 건과 비슷하고 파일 크기보다 훨씬 작다', async () => {
  expect(gc, '--expose-gc로 띄워야 한다(vitest.perf.config.ts)').toBeTypeOf('function');
  // 첫 요청의 JIT·연결 준비가 측정에 섞이지 않게 한 번 받아 둔다
  await measure('?limit=1&action=auth.login');
  // 기록 id 순서상 마지막 1만 건은 시각 필터로 고른다
  const small = await measure(`?action=trigger.pause&from=${t.clock.now + 90_000}`);
  const large = await measure('?action=trigger.pause');

  const result = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    small,
    large,
  };
  console.table({ '1만 건': small, '10만 건': large });
  const dir = join(process.cwd(), '..', '..', 'perf-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'audit-export.json'), `${JSON.stringify(result, null, 2)}\n`);

  expect(small.rows).toBe(10_000);
  expect(large.rows).toBe(100_000);
  // 파일(약 60MB)을 메모리에 모으지 않는다
  expect(large.peakHeapDeltaMb).toBeLessThan(large.bytes / MB / 4);
  // 건수가 10배여도 최대 증가량은 비슷하다(묶음 하나와 소켓 버퍼 크기)
  expect(large.peakHeapDeltaMb).toBeLessThan(Math.max(small.peakHeapDeltaMb * 3, 32));
});
