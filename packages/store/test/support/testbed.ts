import {
  GenericContainer,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { TESTBED_DIR } from './paths.js';
import { TestbedClient } from './testbed-client.js';

/** 테스트베드 Quartz 버전. `QA_IT_QUARTZ_VERSION`으로 바꾼다(예: 2.5.2) */
export const QUARTZ_VERSION = process.env.QA_IT_QUARTZ_VERSION ?? '2.3.2';

const HTTP_PORT = 8080;
const builds = new Map<string, Promise<string>>();

/**
 * 테스트베드 이미지 이름. `QA_IT_TESTBED_IMAGE`가 있으면 그 이미지를 쓰고(CI에서 미리 빌드),
 * 없으면 `tools/quartz-testbed/Dockerfile`을 빌드한다. 빌드는 프로세스마다 버전별로 한 번만 하고 Docker 레이어 캐시를 쓴다.
 */
export function testbedImage(quartzVersion: string = QUARTZ_VERSION): Promise<string> {
  const prebuilt = process.env.QA_IT_TESTBED_IMAGE;
  if (prebuilt) {
    return Promise.resolve(prebuilt);
  }
  let build = builds.get(quartzVersion);
  if (!build) {
    const name = `quartz-admin-testbed:${quartzVersion}-local`;
    build = GenericContainer.fromDockerfile(TESTBED_DIR)
      .withBuildArgs({ QUARTZ_VERSION: quartzVersion })
      .build(name, { deleteOnExit: false })
      .then(() => name);
    builds.set(quartzVersion, build);
  }
  return build;
}

export interface TestbedDb {
  /** 컨테이너 네트워크 안에서 쓰는 JDBC URL */
  jdbcUrl: string;
  user: string;
  password: string;
}

export interface StartTestbedNodeOptions {
  network: StartedNetwork;
  db: TestbedDb;
  /** 기본 {@link testbedImage}() */
  image?: string;
  /** 기본 `TestbedScheduler` */
  schedulerName?: string;
  /** 기본 `AUTO`(Quartz가 호스트 이름과 시각으로 만든다) */
  instanceId?: string;
  /** 기본 `QRTZ_` */
  tablePrefix?: string;
  threadCount?: number;
  /** 기본 2000ms. 운영 기본값(7500ms)보다 짧게 둬 노드 이탈을 빨리 감지한다 */
  clusterCheckinIntervalMs?: number;
  misfireThresholdMs?: number;
  executionsTable?: string;
  /** 그 밖의 Quartz 설정 */
  quartzProperties?: Record<string, string>;
  /**
   * JDBC 드라이버 속성. Oracle은 테스트베드가 `oracle.jdbc.sendBooleanAsNativeBoolean=false`를 기본으로 둔다
   * (Quartz 기본 스키마의 VARCHAR2(1) 불리언 컬럼에 운영과 같은 '1'/'0'을 넣기 위해).
   */
  dbProperties?: Record<string, string>;
  /** 노드 로그를 stderr로 보낸다. 기본은 `QA_IT_LOGS=1`일 때만 */
  logs?: boolean;
  /**
   * false면 `scheduler.start()`를 하지 않는 기준 인스턴스로 띄운다(차등 테스트, TRD §12.1). 발화·misfire 처리·
   * 체크인이 돌지 않아 Quartz API 결과가 결정적이다. 다른 노드와 SCHED_NAME을 함께 쓰지 않는다. 기본 true
   */
  start?: boolean;
}

export interface TestbedNode {
  readonly container: StartedTestContainer;
  readonly schedulerName: string;
  readonly instanceId: string;
  readonly baseUrl: string;
  readonly client: TestbedClient;
  stop(): Promise<void>;
}

const MYSQL_FAMILY_URL = /^jdbc:(mysql|mariadb):/i;

/**
 * MySQL·MariaDB 노드의 권장 설정 (TRD §5.3). 기본 격리 수준(REPEATABLE READ)에서 misfire 처리가 잠금 전에 연 스냅샷으로
 * 일시정지를 되돌리지 않게, 잠금을 먼저 잡고 읽게 한다. 기본값을 보려면 `quartzProperties`로 `true`를 넘긴다
 */
export const MYSQL_FAMILY_QUARTZ_PROPERTIES: Readonly<Record<string, string>> = {
  'org.quartz.jobStore.doubleCheckLockMisfireHandler': 'false',
};

function propertiesText(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** 테스트베드 노드 하나를 띄우고 `/healthz`가 200이 될 때까지(스케줄러 기동 완료, 기준 인스턴스는 생성 완료) 기다린다. */
export async function startTestbedNode(options: StartTestbedNodeOptions): Promise<TestbedNode> {
  const image = options.image ?? (await testbedImage());
  const schedulerName = options.schedulerName ?? 'TestbedScheduler';
  const instanceId = options.instanceId ?? 'AUTO';
  const env: Record<string, string> = {
    TESTBED_DB_URL: options.db.jdbcUrl,
    TESTBED_DB_USER: options.db.user,
    TESTBED_DB_PASSWORD: options.db.password,
    TESTBED_SCHEDULER_NAME: schedulerName,
    TESTBED_INSTANCE_ID: instanceId,
    TESTBED_TABLE_PREFIX: options.tablePrefix ?? 'QRTZ_',
    TESTBED_CLUSTER_CHECKIN_INTERVAL_MS: String(options.clusterCheckinIntervalMs ?? 2000),
    TESTBED_HTTP_PORT: String(HTTP_PORT),
  };
  if (options.start === false) env.TESTBED_START = 'false';
  if (options.threadCount !== undefined) env.TESTBED_THREAD_COUNT = String(options.threadCount);
  if (options.misfireThresholdMs !== undefined) {
    env.TESTBED_MISFIRE_THRESHOLD_MS = String(options.misfireThresholdMs);
  }
  if (options.executionsTable) env.TESTBED_EXECUTIONS_TABLE = options.executionsTable;
  const quartzProperties = {
    ...(MYSQL_FAMILY_URL.test(options.db.jdbcUrl) ? MYSQL_FAMILY_QUARTZ_PROPERTIES : {}),
    ...options.quartzProperties,
  };
  if (Object.keys(quartzProperties).length > 0) {
    env.TESTBED_QUARTZ_PROPERTIES = propertiesText(quartzProperties);
  }
  if (options.dbProperties) {
    env.TESTBED_DB_PROPERTIES = propertiesText(options.dbProperties);
  }

  let container = new GenericContainer(image)
    .withNetwork(options.network)
    .withExposedPorts(HTTP_PORT)
    .withEnvironment(env)
    .withWaitStrategy(Wait.forHttp('/healthz', HTTP_PORT).forStatusCode(200))
    .withStartupTimeout(120_000);
  if (options.logs ?? process.env.QA_IT_LOGS === '1') {
    const label = instanceId === 'AUTO' ? schedulerName : instanceId;
    container = container.withLogConsumer((stream) => {
      stream.on('data', (chunk: Buffer | string) => {
        for (const line of chunk.toString().trimEnd().split('\n')) {
          process.stderr.write(`[testbed ${label}] ${line}\n`);
        }
      });
    });
  }
  const started = await container.start();
  const baseUrl = `http://${started.getHost()}:${started.getMappedPort(HTTP_PORT)}`;
  const client = new TestbedClient(baseUrl);
  const metadata = await client.metadata();

  return {
    container: started,
    schedulerName,
    instanceId: metadata.instanceId,
    baseUrl,
    client,
    async stop() {
      await started.stop();
    },
  };
}
