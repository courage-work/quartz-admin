import { startTestDb, type DbFixture, type StartTestDbOptions, type TestConnection } from './db.js';
import { initQuartzSchema, quartzTableName, type QuartzSchemaOptions } from './quartz-schema.js';
import {
  startTestbedNode,
  testbedImage,
  QUARTZ_VERSION,
  type StartTestbedNodeOptions,
  type TestbedNode,
} from './testbed.js';
import { waitFor } from './wait.js';

export interface StartClusterOptions {
  /** 기본 2 */
  nodes?: number;
  /** 기본 {@link QUARTZ_VERSION} */
  quartzVersion?: string;
  /** 기본 `TestbedScheduler` */
  schedulerName?: string;
  /** 스키마 prefix와 변형. Quartz 노드를 붙이므로 tableCase는 upper만 의미가 있다 */
  schema?: Omit<QuartzSchemaOptions, 'tableCase'>;
  db?: StartTestDbOptions;
  /** 노드마다 덧붙일 옵션 */
  node?: Omit<
    StartTestbedNodeOptions,
    'network' | 'db' | 'image' | 'schedulerName' | 'instanceId' | 'tablePrefix'
  >;
}

export interface QuartzCluster {
  /** `QA_IT_DB`로 고른 DB(Oracle 또는 PostgreSQL) */
  readonly db: DbFixture;
  readonly nodes: TestbedNode[];
  readonly schedulerName: string;
  readonly schema: QuartzSchemaOptions;
  /** 노드를 하나 더 띄운다(instanceId는 `node-N`) */
  addNode(instanceId?: string): Promise<TestbedNode>;
  /**
   * 같은 DB·스키마에 `start()`하지 않는 기준 인스턴스를 띄운다(차등 테스트). 클러스터와 겹치지 않도록
   * 다른 SCHED_NAME을 준다. 클러스터를 멈출 때 함께 멈춘다.
   */
  addReference(schedulerName: string): Promise<TestbedNode>;
  stop(): Promise<void>;
}

/**
 * `QA_IT_DB`의 DB(기본 Oracle Free 23)를 띄우고 Quartz 스키마를 만든 뒤 테스트베드 노드 N개(`node-1`, `node-2`, ...)를
 * 클러스터로 띄운다. 모든 노드가 `SCHEDULER_STATE`에 체크인할 때까지 기다린다.
 */
export async function startQuartzCluster(
  options: StartClusterOptions = {},
): Promise<QuartzCluster> {
  const count = options.nodes ?? 2;
  const schedulerName = options.schedulerName ?? 'TestbedScheduler';
  const schema: QuartzSchemaOptions = { ...options.schema, tableCase: 'upper' };
  const tablePrefix = schema.prefix ?? 'QRTZ_';

  // DB 기동과 이미지 빌드는 서로 기다릴 필요가 없다
  const [dbResult, imageResult] = await Promise.allSettled([
    startTestDb(options.db),
    testbedImage(options.quartzVersion ?? QUARTZ_VERSION),
  ]);
  if (dbResult.status === 'rejected' || imageResult.status === 'rejected') {
    if (dbResult.status === 'fulfilled') await dbResult.value.stop();
    throw dbResult.status === 'rejected'
      ? dbResult.reason
      : (imageResult as PromiseRejectedResult).reason;
  }
  const db = dbResult.value;
  const image = imageResult.value;
  const nodes: TestbedNode[] = [];
  const references: TestbedNode[] = [];
  try {
    await db.withConnection((conn) => initQuartzSchema(conn, schema));

    const startNode = (instanceId: string, reference?: { schedulerName: string }) =>
      startTestbedNode({
        ...options.node,
        network: db.network,
        db: { jdbcUrl: db.jdbcUrl, user: db.user, password: db.password },
        image,
        schedulerName: reference?.schedulerName ?? schedulerName,
        instanceId,
        tablePrefix,
        ...(reference ? { start: false } : {}),
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
    await db.withConnection((conn) =>
      waitForCheckedInNodes(conn, { schedulerName, schema, count }),
    );

    return {
      db,
      nodes,
      schedulerName,
      schema,
      async addNode(instanceId = `node-${nodes.length + 1}`) {
        const node = await startNode(instanceId);
        nodes.push(node);
        return node;
      },
      async addReference(refName) {
        const node = await startNode('reference', { schedulerName: refName });
        references.push(node);
        return node;
      },
      async stop() {
        await Promise.allSettled([...nodes, ...references].map((n) => n.stop()));
        await db.stop();
      },
    };
  } catch (error) {
    await Promise.allSettled(nodes.map((n) => n.stop()));
    await db.stop();
    throw error;
  }
}

/** `SCHEDULER_STATE`에 체크인한 인스턴스 이름 목록 */
export async function checkedInInstances(
  conn: TestConnection,
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
  conn: TestConnection,
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
