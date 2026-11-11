import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { QUARTZ_VERSION, TEST_DB_LABEL, sleep, startQuartzCluster } from '../support/index.js';

/**
 * 화면·API를 손으로 확인할 때 쓰는 테스트베드 클러스터 (`pnpm --filter @qa/store testbed:up`).
 * `QA_IT_DB`의 DB(기본 Oracle Free 23, `postgres`면 PostgreSQL, `mysql`이면 MySQL, `mariadb`면 MariaDB)와 Quartz 2노드를 띄우고, 접속 정보를 `QA_TESTBED_INFO`(기본 `.testbed.json`)에 쓴 뒤
 * `QA_TESTBED_STOP` 파일이 생기거나 `QA_TESTBED_MINUTES`(기본 120)분이 지날 때까지 기다린다.
 * 프로세스를 끝내면 Testcontainers가 컨테이너를 지운다.
 */
const INFO = process.env.QA_TESTBED_INFO ?? '.testbed.json';
const STOP = process.env.QA_TESTBED_STOP ?? '.testbed.stop';
const MINUTES = Number(process.env.QA_TESTBED_MINUTES ?? 120);

it(`테스트베드 클러스터 (${TEST_DB_LABEL}, Quartz ${QUARTZ_VERSION})`, async () => {
  rmSync(STOP, { force: true });
  const cluster = await startQuartzCluster({ nodes: 2 });
  try {
    const client = cluster.nodes[0]!.client;
    await client.scheduleJob({
      job: { name: 'every-minute', group: 'demo', type: 'RecordingJob', data: { owner: 'demo' } },
      trigger: { name: 'every-minute', group: 'demo', type: 'cron', cron: '0 * * * * ?' },
    });
    await client.scheduleJob({
      job: { name: 'every-10s', group: 'demo', type: 'RecordingJob' },
      trigger: { name: 'every-10s', group: 'demo', type: 'simple', intervalMs: 10_000 },
    });

    const target = cluster.db.targetInfo();
    const info = {
      dbType: target.kind,
      host: target.host,
      port: target.port,
      ...(target.oracleServiceName
        ? { oracleServiceName: target.oracleServiceName }
        : { database: target.database }),
      username: target.username,
      password: target.password,
      schedulerName: cluster.schedulerName,
      nodes: cluster.nodes.length,
    };
    writeFileSync(INFO, `${JSON.stringify(info, null, 2)}\n`);
    console.log(`테스트베드 준비 완료. 접속 정보: ${INFO}. 끝내려면 ${STOP} 파일을 만드세요.`);

    const deadline = Date.now() + MINUTES * 60_000;
    while (!existsSync(STOP) && Date.now() < deadline) await sleep(1_000);
  } finally {
    rmSync(INFO, { force: true });
    rmSync(STOP, { force: true });
    await cluster.stop();
  }
});
