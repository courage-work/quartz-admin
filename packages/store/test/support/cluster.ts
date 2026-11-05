import type oracledb from 'oracledb';
import { startOracle, type OracleFixture, type StartOracleOptions } from './oracle.js';
import { initQuartzSchema, quartzTableName, type QuartzSchemaOptions } from './quartz-schema.js';
import {
  startTestbedNode,
  testbedImage,
  QUARTZ_VERSION,
  type StartTestbedNodeOptions,
  type TestbedNode,
} from './testbed.js';
import { waitFor } from './wait.js';

export interface StartOracleClusterOptions {
  /** 기본 2 */
  nodes?: number;
  /** 기본 {@link QUARTZ_VERSION} */
  quartzVersion?: string;
  /** 기본 `TestbedScheduler` */
  schedulerName?: string;
  /** 스키마 prefix와 변형. Quartz 노드를 붙이므로 tableCase는 upper만 의미가 있다 */
  schema?: Omit<QuartzSchemaOptions, 'tableCase'>;
  oracle?: StartOracleOptions;
  /** 노드마다 덧붙일 옵션 */
  node?: Omit<
    StartTestbedNodeOptions,
    'network' | 'db' | 'image' | 'schedulerName' | 'instanceId' | 'tablePrefix'
  >;
}

export interface OracleQuartzCluster {
  readonly oracle: OracleFixture;
  readonly nodes: TestbedNode[];
  readonly schedulerName: string;
  readonly schema: QuartzSchemaOptions;
  /** 노드를 하나 더 띄운다(instanceId는 `node-N`) */
  addNode(instanceId?: string): Promise<TestbedNode>;
  stop(): Promise<void>;
}

/**
 * Oracle Free 23을 띄우고 Quartz 스키마를 만든 뒤 테스트베드 노드 N개(`node-1`, `node-2`, ...)를 클러스터로 띄운다.
 * 모든 노드가 `SCHEDULER_STATE`에 체크인할 때까지 기다린다.
 */
export async function startOracleQuartzCluster(
  options: StartOracleClusterOptions = {},
): Promise<OracleQuartzCluster> {
  const count = options.nodes ?? 2;
  const schedulerName = options.schedulerName ?? 'TestbedScheduler';
  const schema: QuartzSchemaOptions = { ...options.schema, tableCase: 'upper' };
  const tablePrefix = schema.prefix ?? 'QRTZ_';

  // Oracle 기동과 이미지 빌드는 서로 기다릴 필요가 없다
  const [oracleResult, imageResult] = await Promise.allSettled([
    startOracle(options.oracle),
    testbedImage(options.quartzVersion ?? QUARTZ_VERSION),
  ]);
  if (oracleResult.status === 'rejected' || imageResult.status === 'rejected') {
    if (oracleResult.status === 'fulfilled') {
      await oracleResult.value.stop();
    }
    throw oracleResult.status === 'rejected'
      ? oracleResult.reason
      : (imageResult as PromiseRejectedResult).reason;
  }
  const oracle = oracleResult.value;
  const image = imageResult.value;
  const nodes: TestbedNode[] = [];
  try {
    await oracle.withConnection((conn) => initQuartzSchema(conn, schema));

    const startNode = (instanceId: string) =>
      startTestbedNode({
        ...options.node,
        network: oracle.network,
        db: { jdbcUrl: oracle.jdbcUrl, user: oracle.user, password: oracle.password },
        image,
        schedulerName,
        instanceId,
        tablePrefix,
        // tables_oracle23.sql은 불리언 컬럼이 BOOLEAN이라 드라이버가 네이티브 불리언을 보내야 한다
        dbProperties: {
          ...(schema.variant === 'oracle23'
            ? { 'oracle.jdbc.sendBooleanAsNativeBoolean': 'true' }
            : {}),
          ...options.node?.dbProperties,
        },
      });

    nodes.push(
      ...(await Promise.all(Array.from({ length: count }, (_, i) => startNode(`node-${i + 1}`)))),
    );
    await oracle.withConnection((conn) =>
      waitForCheckedInNodes(conn, { schedulerName, schema, count }),
    );

    return {
      oracle,
      nodes,
      schedulerName,
      schema,
      async addNode(instanceId = `node-${nodes.length + 1}`) {
        const node = await startNode(instanceId);
        nodes.push(node);
        return node;
      },
      async stop() {
        await Promise.allSettled(nodes.map((n) => n.stop()));
        await oracle.stop();
      },
    };
  } catch (error) {
    await Promise.allSettled(nodes.map((n) => n.stop()));
    await oracle.stop();
    throw error;
  }
}

/** `SCHEDULER_STATE`에 체크인한 인스턴스 이름 목록 */
export async function checkedInInstances(
  conn: oracledb.Connection,
  { schedulerName, schema = {} }: { schedulerName: string; schema?: QuartzSchemaOptions },
): Promise<string[]> {
  const result = await conn.execute<[string]>(
    `SELECT INSTANCE_NAME FROM ${quartzTableName('SCHEDULER_STATE', schema)} WHERE SCHED_NAME = :1 ORDER BY INSTANCE_NAME`,
    [schedulerName],
  );
  return (result.rows ?? []).map(([name]) => name);
}

/** 노드 `count`개가 체크인할 때까지 기다린다 */
export function waitForCheckedInNodes(
  conn: oracledb.Connection,
  options: {
    schedulerName: string;
    schema?: QuartzSchemaOptions;
    count: number;
    timeoutMs?: number;
  },
): Promise<string[]> {
  return waitFor(
    async () => {
      const names = await checkedInInstances(conn, options);
      return names.length >= options.count ? names : null;
    },
    { message: `노드 ${options.count}개 체크인`, timeoutMs: options.timeoutMs ?? 60_000 },
  );
}
