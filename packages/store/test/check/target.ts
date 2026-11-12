import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import oracledb from 'oracledb';
import { Network, type StartedNetwork } from 'testcontainers';
import type { TargetConnectInfo } from '../../src/adapter.js';
import { oracleConnectString } from '../../src/oracle/connect-string.js';
import { startOracle, wrapOracle, type TestConnection } from '../support/index.js';

/**
 * 점검 대상 Oracle (B-35). `QA_CHECK_TARGET` JSON 파일(기본 `packages/store/.check-target.json`, git 제외)로 사내 DB를
 * 가리키고, 파일이 없으면 로컬 Oracle 컨테이너(`QA_IT_ORACLE_VERSION`, 기본 Free 23)를 띄워 같은 점검을 돌린다(도구 자체 검증용).
 */
export interface CheckTargetFile {
  host: string;
  port: number;
  /** 서비스 이름과 SID 중 하나 */
  serviceName?: string;
  sid?: string;
  username: string;
  password: string;
  /** Quartz 테이블 소유 스키마. 비우면 접속 계정 */
  schema?: string;
  /** 읽기 점검할 SCHED_NAME. 비우면 감지한 후보 전부(최대 5개) */
  schedulers?: string[];
  /** 샌드박스 점검(제어·알림). 같은 계정에 `sandboxPrefix` 테이블을 만들고 테스트베드 노드를 붙인 뒤 지운다 */
  sandbox?: boolean;
  /** 기본 `QACHK_`. 이미 이 prefix의 테이블이 있으면 샌드박스를 건너뛴다 */
  sandboxPrefix?: string;
  /** 테스트베드 컨테이너가 DB에 붙을 때 쓰는 호스트. 기본 `host`(`localhost`면 `host.docker.internal`) */
  jdbcHost?: string;
  /** 테스트베드 Quartz 버전. 기본 `2.3.2`(사내 주력) */
  quartzVersion?: string;
}

export interface CheckTarget {
  /** 보고서에 적는 대상 설명. 호스트·계정·비밀번호는 넣지 않는다 */
  readonly label: string;
  readonly local: boolean;
  readonly info: TargetConnectInfo;
  readonly schema: string | undefined;
  readonly schedulers: string[] | undefined;
  readonly sandbox: boolean;
  readonly sandboxPrefix: string;
  readonly quartzVersion: string;
  /** 테스트베드 컨테이너에서 쓰는 JDBC URL */
  readonly jdbcUrl: string;
  /** 준비·검증 SQL용 연결 */
  connect(): Promise<TestConnection>;
  /** 테스트베드 노드를 붙일 Docker 네트워크 */
  network(): Promise<StartedNetwork>;
  stop(): Promise<void>;
}

export const CHECK_TARGET_FILE =
  process.env.QA_CHECK_TARGET ?? path.resolve(process.cwd(), '.check-target.json');

export async function openCheckTarget(): Promise<CheckTarget> {
  if (existsSync(CHECK_TARGET_FILE)) return externalTarget(readTargetFile(CHECK_TARGET_FILE));
  return localTarget();
}

function readTargetFile(file: string): CheckTargetFile {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CheckTargetFile>;
  for (const key of ['host', 'port', 'username', 'password'] as const) {
    if (raw[key] === undefined || raw[key] === '') {
      throw new Error(`${file}: ${key}가 없습니다`);
    }
  }
  if (Boolean(raw.serviceName) === Boolean(raw.sid)) {
    throw new Error(`${file}: serviceName과 sid 중 하나만 넣으세요`);
  }
  return raw as CheckTargetFile;
}

function externalTarget(file: CheckTargetFile): CheckTarget {
  const info: TargetConnectInfo = {
    kind: 'oracle',
    host: file.host,
    port: file.port,
    username: file.username,
    password: file.password,
    ...(file.serviceName ? { oracleServiceName: file.serviceName } : { oracleSid: file.sid }),
  };
  const jdbcHost =
    file.jdbcHost ??
    (['localhost', '127.0.0.1'].includes(file.host) ? 'host.docker.internal' : file.host);
  let network: StartedNetwork | undefined;
  return {
    // 보고서를 공유할 때 사내 호스트·계정이 섞이지 않게 접속 방식만 적는다
    label: `설정 파일의 Oracle(${file.serviceName ? '서비스 이름으로' : 'SID로'} 접속)`,
    local: false,
    info,
    schema: file.schema,
    schedulers: file.schedulers,
    sandbox: file.sandbox ?? false,
    sandboxPrefix: file.sandboxPrefix ?? 'QACHK_',
    quartzVersion: file.quartzVersion ?? '2.3.2',
    jdbcUrl: file.serviceName
      ? `jdbc:oracle:thin:@//${jdbcHost}:${file.port}/${file.serviceName}`
      : `jdbc:oracle:thin:@${jdbcHost}:${file.port}:${file.sid}`,
    async connect() {
      return wrapOracle(
        await oracledb.getConnection({
          user: file.username,
          password: file.password,
          connectString: oracleConnectString(info),
        }),
      );
    },
    async network() {
      network ??= await new Network().start();
      return network;
    },
    async stop() {
      await network?.stop();
    },
  };
}

async function localTarget(): Promise<CheckTarget> {
  const o = await startOracle();
  const info: TargetConnectInfo = {
    kind: 'oracle',
    host: o.container.getHost(),
    port: o.container.getMappedPort(1521),
    username: o.user,
    password: o.password,
    oracleServiceName: o.serviceName,
  };
  return {
    label: `로컬 ${o.edition.label} 컨테이너(도구 검증용)`,
    local: true,
    info,
    schema: undefined,
    schedulers: undefined,
    // 로컬은 읽기 점검할 기존 스키마가 없으므로 샌드박스를 만들어 두 단계를 모두 돈다
    sandbox: true,
    sandboxPrefix: 'QACHK_',
    quartzVersion: process.env.QA_IT_QUARTZ_VERSION ?? '2.3.2',
    jdbcUrl: o.jdbcUrl,
    async connect() {
      return wrapOracle(await o.connect());
    },
    network: () => Promise.resolve(o.network),
    stop: () => o.stop(),
  };
}
