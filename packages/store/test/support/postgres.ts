import pg from 'pg';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

/** PostgreSQL 버전. `QA_IT_POSTGRES_VERSION`으로 바꾼다(예: 11). 이미지는 `postgres:<버전>-alpine` */
export const POSTGRES_VERSION = process.env.QA_IT_POSTGRES_VERSION ?? '17';

const POSTGRES_PORT = 5432;
const DATABASE = 'quartz';

export interface StartPostgresOptions {
  network?: StartedNetwork;
  /** 기본 `postgres:<POSTGRES_VERSION>-alpine` */
  image?: string;
  /** 네트워크 안 호스트 이름. 기본 `postgres` */
  alias?: string;
  /** 앱 계정(DB 소유자). 기본 `quartz` */
  user?: string;
  password?: string;
}

export interface PostgresCredentials {
  user: string;
  password: string;
}

export interface PostgresFixture {
  readonly container: StartedTestContainer;
  readonly network: StartedNetwork;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** 같은 Docker 네트워크의 테스트베드가 쓰는 JDBC URL */
  readonly jdbcUrl: string;
  readonly user: string;
  readonly password: string;
  /** pg 클라이언트로 접속한다. int8은 Number로 읽는다. 닫는 것은 호출한 쪽 책임이다 */
  connect(credentials?: PostgresCredentials): Promise<pg.Client>;
  /** 로그인 역할을 하나 더 만든다. 같은 이름의 스키마를 그 역할 소유로 만든다(Oracle의 계정 = 스키마와 비슷하게) */
  createUser(user: string, password: string): Promise<PostgresCredentials>;
  stop(): Promise<void>;
}

const INT8_OID = 20;
/** 테스트용 타입 파서. int8을 Number로(제품 어댑터와 같음) */
export const PG_TEST_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === INT8_OID && format !== 'binary'
      ? (v: string) => Number(v)
      : (pg.types.getTypeParser(oid, format ?? 'text') as (
          v: string,
        ) => unknown)) as pg.CustomTypesConfig['getTypeParser'],
};

export async function startPostgres(options: StartPostgresOptions = {}): Promise<PostgresFixture> {
  const ownNetwork = options.network === undefined;
  const network = options.network ?? (await new Network().start());
  const alias = options.alias ?? 'postgres';
  const user = options.user ?? 'quartz';
  const password = options.password ?? 'Quartz_test1';
  const image =
    options.image ?? process.env.QA_IT_POSTGRES_IMAGE ?? `postgres:${POSTGRES_VERSION}-alpine`;

  const container = await new GenericContainer(image)
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withExposedPorts(POSTGRES_PORT)
    .withEnvironment({ POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: DATABASE })
    // 초기화 중에 한 번, 실제 기동 뒤에 한 번 나온다
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(POSTGRES_PORT);
  const connect = async (credentials: PostgresCredentials = { user, password }) => {
    const client = new pg.Client({
      host,
      port,
      database: DATABASE,
      user: credentials.user,
      password: credentials.password,
      types: PG_TEST_TYPES,
    });
    await client.connect();
    return client;
  };

  return {
    container,
    network,
    host,
    port,
    database: DATABASE,
    jdbcUrl: `jdbc:postgresql://${alias}:${POSTGRES_PORT}/${DATABASE}`,
    user,
    password,
    connect,
    async createUser(name, pw) {
      if (!/^[a-z][a-z0-9_]*$/.test(name) || pw.includes("'")) {
        throw new Error(`만들 수 없는 역할 이름 또는 비밀번호입니다: ${name}`);
      }
      const admin = await connect();
      try {
        await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${pw}'`);
        await admin.query(`CREATE SCHEMA ${name} AUTHORIZATION ${name}`);
      } finally {
        await admin.end();
      }
      return { user: name, password: pw };
    },
    async stop() {
      await container.stop();
      if (ownNetwork) await network.stop();
    },
  };
}
