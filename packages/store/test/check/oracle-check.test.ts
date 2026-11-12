import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlertRuleType, CommandExpected, QuartzCommand } from '@qa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TargetConn } from '../../src/adapter.js';
import { evaluateRule } from '../../src/alerts/evaluate.js';
import type { DetectedTableSet, QuartzDetection } from '../../src/detect/types.js';
import {
  TargetError,
  collectMonitorData,
  createDriverAdapters,
  createTableSet,
  detectQuartz,
  executeCommand,
  expectedOf,
  getJobDetail,
  getTriggerDetail,
  listExecuting,
  listGroups,
  listJobs,
  listNodes,
  listPausedGroups,
  listTriggers,
  oracleDialect,
  previewCommand,
  queryDbNowMillis,
  type SchedulerCommandContext,
} from '../../src/index.js';
import {
  dropQuartzSchema,
  initQuartzSchema,
  quartzTableName,
  startTestbedNode,
  testbedImage,
  triggerAccessIsFree,
  waitForCheckedInNodes,
  waitForExecutions,
  type TestConnection,
  type TestbedNode,
} from '../support/index.js';
import { CHECK_TARGET_FILE, openCheckTarget, type CheckTarget } from './target.js';

/**
 * 사내 Oracle 구버전 점검 (B-35, TRD §5.1). `pnpm --filter @qa/store check:oracle`로 손으로 돌린다.
 *
 * 1. 환경: 접속, DB 버전·문자셋, 시계 차이, 인증 실패 분류
 * 2. 샌드박스 준비(선택): 같은 계정에 `QACHK_` 테이블을 만들고 테스트베드 노드 2개와 기준 인스턴스를 붙인다
 * 3. 감지: 테이블 세트, 선택 컬럼, 불리언 형식, 쓰기 권한, SCHED_NAME 후보
 * 4. 조회·감시: 후보 스케줄러마다 감시 1회와 화면 조회(모두 SELECT만 실행)
 * 5. 제어(샌드박스만): 일시정지·재개(트리거·잡·그룹), 즉시 실행, 스케줄 수정, 삭제
 * 6. 알림 판정(샌드박스만): ERROR 트리거, 연체, 노드 부족, 클러스터 중단
 * 7. 정리: 노드를 멈추고 샌드박스 테이블을 지운다
 *
 * 대상은 `QA_CHECK_TARGET`(기본 `.check-target.json`)이고, 없으면 로컬 Oracle 컨테이너로 같은 점검을 돈다.
 * 결과는 `QA_CHECK_REPORT_DIR`(기본 레포 루트 `check-results/`)에 마크다운으로 남는다.
 */
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const REPORT_DIR = process.env.QA_CHECK_REPORT_DIR ?? path.join(REPO, 'check-results');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const MAX_READ_SCHEDULERS = 6;
const GROUP = 'qachk';

type Outcome = 'pass' | 'fail' | 'skip';
interface Item {
  phase: string;
  name: string;
  outcome: Outcome;
  ms: number;
  note: string;
}

const items: Item[] = [];
const env: string[] = [];

function describeError(err: unknown): string {
  if (err instanceof TargetError) {
    return `${err.code}${err.driverCode ? ` ${err.driverCode}` : ''}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`;
  }
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

/** 점검 항목 하나. 실패해도 다음 항목으로 넘어가고, 마지막에 실패 목록으로 판정한다 */
async function check(
  phase: string,
  name: string,
  fn: () => Promise<string | void> | string | void,
): Promise<boolean> {
  const started = performance.now();
  try {
    const note = (await fn()) ?? '';
    items.push({ phase, name, outcome: 'pass', ms: performance.now() - started, note });
    return true;
  } catch (err) {
    items.push({
      phase,
      name,
      outcome: 'fail',
      ms: performance.now() - started,
      note: describeError(err),
    });
    return false;
  }
}

function skip(phase: string, name: string, note: string): void {
  items.push({ phase, name, outcome: 'skip', ms: 0, note });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function renderReport(target: CheckTarget | undefined): string {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const i of items) counts[i.outcome]++;
  const phases = [...new Set(items.map((i) => i.phase))];
  return [
    '# 사내 Oracle 점검 결과 (B-35)',
    '',
    `- 시각: ${new Date().toISOString()}`,
    `- 대상: ${target?.label ?? '(열지 못함)'}`,
    `- 결과: 통과 ${counts.pass}, 실패 ${counts.fail}, 건너뜀 ${counts.skip}`,
    ...env.map((e) => `- ${e}`),
    '',
    ...phases.flatMap((phase) => [
      `## ${phase}`,
      '',
      '| 항목 | 결과 | ms | 비고 |',
      '| --- | --- | --- | --- |',
      ...items
        .filter((i) => i.phase === phase)
        .map(
          (i) =>
            `| ${cell(i.name)} | ${i.outcome === 'pass' ? '통과' : i.outcome === 'fail' ? '**실패**' : '건너뜀'} | ${Math.round(i.ms)} | ${cell(i.note)} |`,
        ),
      '',
    ]),
  ].join('\n');
}

describe('사내 Oracle 점검', () => {
  let target: CheckTarget | undefined;
  let conn: TargetConn | undefined;
  let sql: TestConnection | undefined;
  const nodes: TestbedNode[] = [];
  let sandboxCreated = false;
  let sandboxReady = false;
  const SCHED = 'QACHK_SCHED';
  const REF = 'QACHK_REF';
  let detection: QuartzDetection | undefined;
  let sandboxSet: DetectedTableSet | undefined;
  const P = () => target!.sandboxPrefix;
  const T = (table: string) =>
    quartzTableName(table as Parameters<typeof quartzTableName>[0], { prefix: P(), db: 'oracle' });

  const ctxOf = (
    set: DetectedTableSet,
    schema: string,
    schedName: string,
  ): SchedulerCommandContext => ({
    dialect: oracleDialect,
    tables: createTableSet(oracleDialect, { schema, tables: set.tableNames }),
    features: set.features,
    schedName,
  });

  beforeAll(async () => {
    mkdirSync(REPORT_DIR, { recursive: true });
    target = await openCheckTarget();
  });

  afterAll(async () => {
    // 7. 정리: 실패해도 보고서는 남긴다
    await Promise.allSettled(nodes.map((n) => n.stop()));
    if (sandboxCreated && sql) {
      await check('7. 정리', `샌드박스 테이블 삭제(${P()}*)`, async () => {
        await dropQuartzSchema(sql!, { prefix: P(), db: 'oracle' });
        try {
          await sql!.execute(`DROP TABLE ${P()}EXECUTIONS PURGE`);
        } catch (err) {
          if (!String(err).includes('ORA-00942')) throw err;
        }
      });
    }
    await sql?.close().catch(() => {});
    await conn?.close().catch(() => {});
    await target?.stop();
    const file = path.join(REPORT_DIR, `oracle-${STAMP}.md`);
    writeFileSync(file, renderReport(target));
    console.log(`[check] 결과: ${file}`);
  });

  it('1. 환경', async () => {
    const phase = '1. 환경';
    env.push(
      `설정 파일: ${target!.local ? `없음(${CHECK_TARGET_FILE}) → 로컬 컨테이너` : CHECK_TARGET_FILE}`,
    );
    const adapter = createDriverAdapters().find((a) => a.kind === 'oracle')!;
    const ok = await check(phase, '제품 어댑터로 접속(oracledb Thin)', async () => {
      conn = await adapter.connect(target!.info, {
        connectTimeoutMs: 10_000,
        queryTimeoutMs: 30_000,
      });
    });
    if (!ok) return;
    await check(phase, 'DB 버전', async () => {
      const rows = await conn!.query(
        `SELECT PRODUCT AS "P", VERSION AS "V" FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle%'`,
      );
      const text = rows.map((r) => `${String(r.P).trim()} ${String(r.V)}`).join(', ');
      env.push(`DB: ${text}`);
      return text;
    });
    await check(phase, '문자셋', async () => {
      const rows = await conn!.query(
        `SELECT PARAMETER AS "K", VALUE AS "V" FROM NLS_DATABASE_PARAMETERS ` +
          `WHERE PARAMETER IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET')`,
      );
      const text = rows.map((r) => `${String(r.K)}=${String(r.V)}`).join(', ');
      env.push(`문자셋: ${text}`);
      return text;
    });
    await check(phase, 'DB 시각과 시계 차이', async () => {
      const before = Date.now();
      const dbNow = await queryDbNowMillis(conn!, oracleDialect);
      const skew = Math.round(dbNow - (before + Date.now()) / 2);
      assert(
        Math.abs(skew) < 30_000,
        `시계 차이가 30초를 넘습니다(${skew}ms). 대시보드에 경고가 뜹니다`,
      );
      return `차이 ${skew}ms`;
    });
    await check(phase, '없는 계정은 TARGET_AUTH_FAILED이고 메시지에 접속 정보가 없다', async () => {
      // 계정 잠금(FAILED_LOGIN_ATTEMPTS)을 피하려고 틀린 비밀번호 대신 없는 계정으로 시도한다
      const err = await adapter
        .connect(
          { ...target!.info, username: 'QA_CHECK_NO_SUCH_USER', password: 'x' },
          { connectTimeoutMs: 10_000, queryTimeoutMs: 10_000 },
        )
        .then(
          async (c) => {
            await c.close();
            return null;
          },
          (e: unknown) => e,
        );
      assert(err instanceof TargetError, '접속이 성공했습니다');
      assert(err.code === 'TARGET_AUTH_FAILED', `${err.code} ${err.driverCode ?? ''}`);
      const text = JSON.stringify(err);
      for (const secret of [target!.info.host, 'QA_CHECK_NO_SUCH_USER']) {
        assert(!text.includes(secret), `오류에 접속 정보가 남았습니다: ${secret}`);
      }
      return `${err.driverCode ?? ''}`;
    });
  });

  it('2. 샌드박스 준비', async () => {
    const phase = '2. 샌드박스 준비';
    if (!conn) return skip(phase, '샌드박스', '접속 실패');
    if (!target!.sandbox)
      return skip(phase, '샌드박스', '설정 파일의 sandbox가 꺼져 있음(제어·알림 점검 생략)');
    const okConn = await check(phase, '준비용 연결', async () => {
      sql = await target!.connect();
    });
    if (!okConn) return;
    const free = await check(phase, `${P()} 테이블이 없음`, async () => {
      const res = await sql!.execute<[number]>(
        `SELECT COUNT(*) FROM USER_TABLES WHERE TABLE_NAME LIKE :1 ESCAPE '!'`,
        [`${P().replace(/_/g, '!_')}%`],
      );
      const n = Number(res.rows![0]![0]);
      assert(n === 0, `이미 ${n}개 있습니다. 다른 sandboxPrefix를 쓰거나 직접 확인하세요`);
    });
    if (!free) return;
    const created = await check(phase, 'Quartz 스키마 생성(tables_oracle.sql)', async () => {
      sandboxCreated = true;
      await initQuartzSchema(sql!, { prefix: P(), db: 'oracle' });
    });
    if (!created) return;
    const started = await check(
      phase,
      `테스트베드 노드 2개 + 기준 인스턴스(Quartz ${target!.quartzVersion})`,
      async () => {
        const image = await testbedImage(target!.quartzVersion);
        const network = await target!.network();
        const db = {
          jdbcUrl: target!.jdbcUrl,
          user: target!.info.username,
          password: target!.info.password,
        };
        const common = {
          network,
          db,
          image,
          tablePrefix: P(),
          executionsTable: `${P()}EXECUTIONS`,
        };
        nodes.push(
          ...(await Promise.all(
            ['node-1', 'node-2'].map((instanceId) =>
              startTestbedNode({ ...common, schedulerName: SCHED, instanceId }),
            ),
          )),
        );
        nodes.push(
          await startTestbedNode({
            ...common,
            schedulerName: REF,
            instanceId: 'reference',
            start: false,
          }),
        );
        await waitForCheckedInNodes(sql!, {
          schedulerName: SCHED,
          schema: { prefix: P(), db: 'oracle' },
          count: 2,
        });
        return `노드 ${nodes.length - 1}개 체크인`;
      },
    );
    if (!started) return;
    sandboxReady = await check(phase, '테스트 잡·트리거 등록', async () => {
      const client = nodes[0]!.client;
      await client.scheduleJob({
        job: { name: 'qachk-a', group: GROUP, type: 'RecordingJob' },
        trigger: { name: 'a-cron', group: GROUP, type: 'cron', cron: '0/10 * * * * ?' },
      });
      await client.scheduleJob({
        job: { name: 'qachk-b', group: GROUP, type: 'RecordingJob' },
        trigger: {
          name: 'b-simple',
          group: GROUP,
          type: 'simple',
          intervalMs: 60_000,
          startAt: Date.now() + 3_600_000,
        },
      });
      await client.scheduleJob({
        job: { name: 'qachk-c', group: GROUP, type: 'RecordingJob', durable: true },
        trigger: {
          name: 'c-daily',
          group: GROUP,
          type: 'cron',
          cron: '0 0 3 * * ?',
          timeZone: 'Asia/Seoul',
        },
      });
      const ref = nodes[2]!.client;
      for (const name of ['r-error', 'r-late']) {
        await ref.scheduleJob({
          job: { name: `job-${name}`, group: GROUP, type: 'RecordingJob' },
          trigger: { name, group: GROUP, type: 'cron', cron: '0 0 3 * * ?' },
        });
      }
    });
  });

  it('3. 감지', async () => {
    const phase = '3. 감지';
    if (!conn) return skip(phase, '감지', '접속 실패');
    await check(phase, `detectQuartz(스키마 ${target!.schema ?? '접속 계정'})`, async () => {
      detection = await detectQuartz(conn!, oracleDialect, { schema: target!.schema });
      return `스키마 ${detection.schema}, 테이블 세트 ${detection.tableSets.length}개, 쓸 수 없음 ${detection.unusable.length}개`;
    });
    if (!detection) return;
    if (
      target!.sandbox &&
      target!.schema &&
      detection.schema !== target!.info.username.toUpperCase()
    ) {
      // 샌드박스는 접속 계정에 만들므로 따로 감지한다
      const own = await detectQuartz(conn, oracleDialect);
      sandboxSet = own.tableSets.find((s) => s.prefix === P());
    } else {
      sandboxSet = detection.tableSets.find((s) => s.prefix === P());
    }
    for (const u of detection.unusable) {
      skip(phase, `쓸 수 없는 세트 ${u.prefix}`, `${u.reason} ${u.tables?.join(', ') ?? ''}`);
    }
    for (const set of detection.tableSets) {
      await check(phase, `테이블 세트 ${set.prefix || '(prefix 없음)'}`, () => {
        const features = Object.entries(set.features)
          .filter(([, on]) => !on)
          .map(([k]) => k);
        const privileges = set.missingPrivileges.map((m) => `${m.table}.${m.privilege}`);
        return [
          `불리언 ${set.boolFormat}(${set.boolFormatSource})`,
          `쓰기 ${set.writeCapable ? '가능' : `불가(빠진 권한 ${privileges.join(', ')})`}`,
          features.length ? `없는 선택 기능 ${features.join(', ')}` : '선택 기능 모두 있음',
          `후보 ${set.schedulers.map((s) => `${s.schedName}(트리거 ${s.triggerCount}, 노드 ${s.activeNodeCount}/${s.nodeCount})`).join(', ') || '없음'}`,
          set.warnings.length ? `경고 ${set.warnings.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
      });
    }
    if (target!.sandbox && sandboxReady) {
      await check(phase, '샌드박스 세트를 찾고 쓰기 가능으로 판정', () => {
        assert(sandboxSet, `${P()} 세트를 찾지 못했습니다`);
        assert(sandboxSet.writeCapable, '쓰기 불가로 판정했습니다');
        assert(sandboxSet.boolFormat === '10', `불리언 형식 ${sandboxSet.boolFormat}`);
        const names = sandboxSet.schedulers.map((s) => s.schedName);
        assert(names.includes(SCHED) && names.includes(REF), `후보 ${names.join(', ')}`);
      });
    }
  });

  it('4. 조회·감시', async () => {
    const phase = '4. 조회·감시';
    if (!conn || !detection) return skip(phase, '조회', '감지 실패');
    const picks: { set: DetectedTableSet; schema: string; schedName: string }[] = [];
    for (const set of detection.tableSets) {
      for (const c of set.schedulers) {
        if (target!.schedulers && !target!.schedulers.includes(c.schedName)) continue;
        picks.push({ set, schema: detection.schema, schedName: c.schedName });
      }
    }
    if (sandboxSet && !picks.some((p) => p.set.prefix === P())) {
      picks.push({
        set: sandboxSet,
        schema: target!.info.username.toUpperCase(),
        schedName: SCHED,
      });
    }
    if (picks.length === 0) return skip(phase, '조회', '읽을 스케줄러가 없음');
    for (const pick of picks.slice(0, MAX_READ_SCHEDULERS)) {
      const ctx = ctxOf(pick.set, pick.schema, pick.schedName);
      const who = `${pick.schedName}(${pick.set.prefix || 'prefix 없음'})`;
      const c = conn;
      let firstTrigger: { group: string; name: string } | undefined;
      let firstJob: { group: string; name: string } | undefined;
      let triggerTotal = 0;
      await check(phase, `${who}: 감시 1회`, async () => {
        const d = await collectMonitorData(c, ctx, {
          checkinMultiplier: 3,
          overdueAfterMs: 120_000,
        });
        return `상태별 ${JSON.stringify(d.triggerCounts)}, 노드 ${d.nodes.length}, 연체 ${d.overdueCount}, ERROR ${d.errorTriggers.length}, BLOCKED ${d.blockedTriggers.length}, 실행 중 ${d.executingCount}`;
      });
      await check(phase, `${who}: 노드`, async () => {
        const n = await listNodes(c, ctx, {
          dbNow: await queryDbNowMillis(c, oracleDialect),
          checkinMultiplier: 3,
        });
        return `${n.length}개`;
      });
      await check(phase, `${who}: 트리거 목록(키 정렬, 1쪽)`, async () => {
        const r = await listTriggers(c, ctx, { sort: 'key', page: 1, size: 50 });
        triggerTotal = r.total;
        firstTrigger = r.items[0];
        // 한글 이름이 깨지지 않는지 보고서에서 볼 수 있게 첫 항목을 적는다
        return `전체 ${r.total}, ${r.items.length}개${firstTrigger ? `, 첫 항목 ${firstTrigger.group} / ${firstTrigger.name}` : ''}`;
      });
      await check(phase, `${who}: 트리거 목록(다음 실행 정렬, 마지막 쪽)`, async () => {
        const last = Math.max(1, Math.ceil(triggerTotal / 50));
        const r = await listTriggers(c, ctx, { sort: 'nextFireTime', page: last, size: 50 });
        return `${last}쪽 ${r.items.length}개`;
      });
      await check(phase, `${who}: 트리거 상태 필터와 특수문자 검색`, async () => {
        await listTriggers(c, ctx, {
          state: ['WAITING', 'PAUSED'],
          sort: 'key',
          page: 1,
          size: 200,
        });
        // LIKE 이스케이프(ESCAPE 절): %, _, 작은따옴표가 오류 없이 글자 그대로 검색돼야 한다
        const r = await listTriggers(c, ctx, { q: "a%_'b", sort: 'key', page: 1, size: 50 });
        return `특수문자 검색 ${r.total}건`;
      });
      await check(phase, `${who}: 잡 목록과 검색`, async () => {
        const r = await listJobs(c, ctx, { page: 1, size: 50 });
        firstJob = r.items[0];
        await listJobs(c, ctx, { page: Math.max(1, Math.ceil(r.total / 50)), size: 50 });
        await listJobs(c, ctx, { q: 'job', page: 1, size: 50 });
        return `전체 ${r.total}`;
      });
      await check(phase, `${who}: 트리거·잡 상세(JobDataMap BLOB 포함)`, async () => {
        if (firstTrigger)
          assert(await getTriggerDetail(c, ctx, firstTrigger), '트리거 상세가 없습니다');
        if (firstJob) assert(await getJobDetail(c, ctx, firstJob), '잡 상세가 없습니다');
        return firstTrigger || firstJob ? '' : '잡·트리거 없음';
      });
      await check(phase, `${who}: 실행 중·일시정지 그룹·그룹 선택지`, async () => {
        await listExecuting(c, ctx, {
          dbNow: await queryDbNowMillis(c, oracleDialect),
          checkinMultiplier: 3,
        });
        await listPausedGroups(c, ctx);
        await listGroups(c, ctx, 'trigger', 500);
        await listGroups(c, ctx, 'job', 500);
      });
    }
  });

  it('5. 제어', async () => {
    const phase = '5. 제어';
    if (!sandboxReady || !sandboxSet || !conn || !sql) {
      return skip(phase, '제어 명령', target?.sandbox ? '샌드박스 준비 실패' : '샌드박스 꺼짐');
    }
    const schema = target!.info.username.toUpperCase();
    const ctx = ctxOf(sandboxSet, schema, SCHED);
    const c = conn;
    const run = async (command: QuartzCommand, expected?: CommandExpected) => {
      const preview = await previewCommand(c, ctx, command);
      return executeCommand(c, ctx, command, expected ?? expectedOf(preview.subject));
    };
    const row = async (name: string) => {
      const r = await sql!.execute<
        [string, string | null, number | null, number | null, number | null]
      >(
        `SELECT t.TRIGGER_STATE, c.CRON_EXPRESSION, s.REPEAT_INTERVAL, s.REPEAT_COUNT, t.NEXT_FIRE_TIME FROM ${T('TRIGGERS')} t ` +
          `LEFT JOIN ${T('CRON_TRIGGERS')} c ON c.SCHED_NAME = t.SCHED_NAME AND c.TRIGGER_GROUP = t.TRIGGER_GROUP AND c.TRIGGER_NAME = t.TRIGGER_NAME ` +
          `LEFT JOIN ${T('SIMPLE_TRIGGERS')} s ON s.SCHED_NAME = t.SCHED_NAME AND s.TRIGGER_GROUP = t.TRIGGER_GROUP AND s.TRIGGER_NAME = t.TRIGGER_NAME ` +
          `WHERE t.SCHED_NAME = :1 AND t.TRIGGER_GROUP = :2 AND t.TRIGGER_NAME = :3`,
        [SCHED, GROUP, name],
      );
      const v = r.rows?.[0];
      if (!v) return null;
      // WAITING과 ACQUIRED는 노드가 발화 직전에 오가는 상태라 같은 것으로 본다
      return {
        state: v[0] === 'ACQUIRED' ? 'WAITING' : v[0],
        cron: v[1],
        interval: v[2],
        count: v[3],
        nft: v[4],
      };
    };
    const states = async (): Promise<Record<string, string | undefined>> =>
      Object.fromEntries(
        await Promise.all(
          ['a-cron', 'b-simple', 'c-daily'].map(async (n) => [n, (await row(n))?.state] as const),
        ),
      );
    const expectState = async (name: string, state: string) => {
      const r = await row(name);
      assert(r?.state === state, `${name}: ${r?.state ?? '없음'} (기대 ${state})`);
    };
    const trigger = (name: string) => ({ group: GROUP, name });
    const job = (name: string) => ({ group: GROUP, name });

    await check(phase, 'pauseTrigger / resumeTrigger', async () => {
      await run({ type: 'pauseTrigger', trigger: trigger('a-cron') });
      await expectState('a-cron', 'PAUSED');
      await run({ type: 'resumeTrigger', trigger: trigger('a-cron') });
      await expectState('a-cron', 'WAITING');
    });
    await check(phase, 'pauseJob / resumeJob', async () => {
      await run({ type: 'pauseJob', job: job('qachk-b') });
      await expectState('b-simple', 'PAUSED');
      await run({ type: 'resumeJob', job: job('qachk-b') });
      await expectState('b-simple', 'WAITING');
    });
    await check(phase, 'pauseTriggerGroup / resumeTriggerGroup (PAUSED_TRIGGER_GRPS)', async () => {
      await run({ type: 'pauseTriggerGroup', group: GROUP });
      const paused = await states();
      assert(
        Object.values(paused).every((s) => s === 'PAUSED'),
        JSON.stringify(paused),
      );
      const groups = await listPausedGroups(c, ctx);
      assert(groups.includes(GROUP), `일시정지 그룹 ${groups.join(', ')}`);
      await run({ type: 'resumeTriggerGroup', group: GROUP });
      const resumed = await states();
      assert(
        Object.values(resumed).every((s) => s === 'WAITING'),
        JSON.stringify(resumed),
      );
      assert(!(await listPausedGroups(c, ctx)).includes(GROUP), '그룹 표시가 남았습니다');
    });
    await check(phase, 'pauseJobGroup / resumeJobGroup', async () => {
      await run({ type: 'pauseJobGroup', group: GROUP });
      const paused = await states();
      assert(
        Object.values(paused).every((s) => s === 'PAUSED'),
        JSON.stringify(paused),
      );
      await run({ type: 'resumeJobGroup', group: GROUP });
      const resumed = await states();
      assert(
        Object.values(resumed).every((s) => s === 'WAITING'),
        JSON.stringify(resumed),
      );
    });
    await check(phase, 'triggerJob: 노드가 실제로 실행한다', async () => {
      const startedAt = Date.now();
      await run({ type: 'triggerJob', job: job('qachk-c') });
      const records = await waitForExecutions(
        sql!,
        { schedName: SCHED, jobName: 'qachk-c', table: `${P()}EXECUTIONS` },
        { timeoutMs: 60_000 },
      );
      return `${records.length}회 실행, ${Math.round((Date.now() - startedAt) / 1_000)}초`;
    });
    await check(phase, 'updateCronSchedule', async () => {
      await run({
        type: 'updateCronSchedule',
        trigger: trigger('a-cron'),
        cronExpression: '0 30 4 * * ?',
        timeZone: 'Asia/Seoul',
      });
      const r = await row('a-cron');
      assert(r?.cron === '0 30 4 * * ?', `식 ${r?.cron}`);
      assert((r.nft ?? 0) > Date.now(), '다음 실행 시각이 미래가 아닙니다');
    });
    await check(phase, 'updateSimpleSchedule', async () => {
      await run({
        type: 'updateSimpleSchedule',
        trigger: trigger('b-simple'),
        repeatIntervalMs: 120_000,
        repeatCount: 5,
        startAt: Date.now() + 3_600_000,
      });
      const r = await row('b-simple');
      assert(r?.interval === 120_000 && r.count === 5, JSON.stringify(r));
    });
    await check(phase, 'deleteTrigger(마지막 트리거면 durable이 아닌 잡도 삭제)', async () => {
      await run({ type: 'deleteTrigger', trigger: trigger('a-cron') });
      assert((await row('a-cron')) === null, '트리거가 남았습니다');
      assert((await getJobDetail(c, ctx, job('qachk-a'))) === null, '잡이 남았습니다');
    });
    await check(phase, 'deleteJob', async () => {
      await run({ type: 'deleteJob', job: job('qachk-b') });
      assert((await getJobDetail(c, ctx, job('qachk-b'))) === null, '잡이 남았습니다');
      assert((await row('b-simple')) === null, '트리거가 남았습니다');
    });
    await check(phase, 'TRIGGER_ACCESS 잠금이 풀려 있다(FOR UPDATE WAIT)', async () => {
      assert(
        await triggerAccessIsFree(sql!, { kind: 'oracle' }, SCHED, T('LOCKS')),
        '잠금이 남았습니다',
      );
    });
  });

  it('6. 알림 판정', async () => {
    const phase = '6. 알림 판정';
    if (!sandboxReady || !sandboxSet || !conn || !sql) {
      return skip(phase, '알림 규칙', target?.sandbox ? '샌드박스 준비 실패' : '샌드박스 꺼짐');
    }
    const schema = target!.info.username.toUpperCase();
    const c = conn;
    // 기준 인스턴스(start하지 않음)의 트리거에 조건을 만든다. 노드가 없어 Quartz가 되돌리지 않는다
    const dbNow = await queryDbNowMillis(c, oracleDialect);
    await sql.execute(
      `UPDATE ${T('TRIGGERS')} SET TRIGGER_STATE = 'ERROR' WHERE SCHED_NAME = :1 AND TRIGGER_NAME = 'r-error'`,
      [REF],
    );
    await sql.execute(
      `UPDATE ${T('TRIGGERS')} SET NEXT_FIRE_TIME = :1 WHERE SCHED_NAME = :2 AND TRIGGER_NAME = 'r-late'`,
      [dbNow - 600_000, REF],
    );
    await sql.commit();
    const evaluate = async (schedName: string, type: AlertRuleType, expectedNodeCount: number) => {
      const data = await collectMonitorData(c, ctxOf(sandboxSet!, schema, schedName), {
        checkinMultiplier: 3,
        overdueAfterMs: 120_000,
      });
      const result = evaluateRule(
        { type, params: {}, scope: { kind: 'all' } },
        {
          result: { ok: true, data },
          expectedNodeCount,
          blockedSince: new Map(),
          recentlyResumed: new Set(),
        },
      );
      assert(result?.firing, `${type}이 발생하지 않았습니다: ${JSON.stringify(result)}`);
      return JSON.stringify(result.affected).slice(0, 120);
    };
    await check(phase, 'TRIGGER_ERROR', () => evaluate(REF, 'TRIGGER_ERROR', 0));
    await check(phase, 'OVERDUE', () => evaluate(REF, 'OVERDUE', 0));
    await check(phase, 'NODE_MISSING(기대 3, 활성 2)', () => evaluate(SCHED, 'NODE_MISSING', 3));
    await check(phase, 'CLUSTER_DOWN(기준 인스턴스는 체크인하지 않음)', () =>
      evaluate(REF, 'CLUSTER_DOWN', 1),
    );
  });

  it('판정: 실패한 항목이 없다', () => {
    expect(
      items.filter((i) => i.outcome === 'fail').map((i) => `${i.phase} ${i.name}: ${i.note}`),
    ).toEqual([]);
  });
});
