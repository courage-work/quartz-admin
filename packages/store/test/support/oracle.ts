import oracledb from 'oracledb';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

/**
 * Oracle Free 23. gvenzl 이미지는 amd64와 arm64를 함께 제공하므로 Apple Silicon에서도 에뮬레이션 없이 돈다.
 * `QA_IT_ORACLE_IMAGE`로 바꿀 수 있다.
 */
export const ORACLE_DEFAULT_IMAGE = 'gvenzl/oracle-free:23-slim-faststart';

const ORACLE_PORT = 1521;
const SERVICE_NAME = 'FREEPDB1';
// 테스트 컨테이너 전용 계정이다. 외부로 노출되지 않는다
const SYSTEM_PASSWORD = 'QaSystem_23';

export interface StartOracleOptions {
  /** 테스트베드 노드와 같은 네트워크에 둘 때 넘긴다. 없으면 새로 만든다 */
  network?: StartedNetwork;
  image?: string;
  /** 네트워크 안에서 쓰는 호스트 이름. 기본 `oracle` */
  alias?: string;
  /** 앱 계정(FREEPDB1에 생성). 기본 `QUARTZ` */
  user?: string;
  password?: string;
}

export interface OracleCredentials {
  user: string;
  password: string;
}

export interface OracleFixture {
  readonly container: StartedTestContainer;
  readonly network: StartedNetwork;
  /** 호스트(테스트 프로세스)에서 접속하는 oracledb 접속 문자열 */
  readonly connectString: string;
  /** 같은 Docker 네트워크의 컨테이너(테스트베드)가 쓰는 JDBC URL */
  readonly jdbcUrl: string;
  readonly user: string;
  readonly password: string;
  /** 앱 계정(또는 지정한 계정)으로 접속한다. 닫는 것은 호출한 쪽 책임이다 */
  connect(credentials?: OracleCredentials): Promise<oracledb.Connection>;
  withConnection<T>(
    fn: (conn: oracledb.Connection) => Promise<T>,
    credentials?: OracleCredentials,
  ): Promise<T>;
  /** SYSTEM 계정으로 FREEPDB1에 접속해 실행한다(계정·권한 준비용) */
  withSystemConnection<T>(fn: (conn: oracledb.Connection) => Promise<T>): Promise<T>;
  /** 스키마(계정)를 하나 더 만든다. 접속, 테이블 생성 권한과 무제한 테이블스페이스를 준다 */
  createUser(user: string, password: string): Promise<OracleCredentials>;
  stop(): Promise<void>;
}

export async function startOracle(options: StartOracleOptions = {}): Promise<OracleFixture> {
  const ownNetwork = options.network === undefined;
  const network = options.network ?? (await new Network().start());
  const alias = options.alias ?? 'oracle';
  const user = options.user ?? 'QUARTZ';
  const password = options.password ?? 'Quartz_test1';
  const image = options.image ?? process.env.QA_IT_ORACLE_IMAGE ?? ORACLE_DEFAULT_IMAGE;

  const container = await new GenericContainer(image)
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withExposedPorts(ORACLE_PORT)
    .withEnvironment({
      ORACLE_PASSWORD: SYSTEM_PASSWORD,
      APP_USER: user,
      APP_USER_PASSWORD: password,
    })
    .withWaitStrategy(Wait.forLogMessage('DATABASE IS READY TO USE!'))
    .withStartupTimeout(600_000)
    .start();

  const connectString = `${container.getHost()}:${container.getMappedPort(ORACLE_PORT)}/${SERVICE_NAME}`;

  const connect = (credentials: OracleCredentials = { user, password }) =>
    oracledb.getConnection({ ...credentials, connectString });

  const withConnection = async <T>(
    fn: (conn: oracledb.Connection) => Promise<T>,
    credentials?: OracleCredentials,
  ): Promise<T> => {
    const conn = await connect(credentials);
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  };

  const withSystemConnection = <T>(fn: (conn: oracledb.Connection) => Promise<T>) =>
    withConnection(fn, { user: 'SYSTEM', password: SYSTEM_PASSWORD });

  return {
    container,
    network,
    connectString,
    jdbcUrl: `jdbc:oracle:thin:@//${alias}:${ORACLE_PORT}/${SERVICE_NAME}`,
    user,
    password,
    connect,
    withConnection,
    withSystemConnection,
    async createUser(name, pw) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || pw.includes('"')) {
        throw new Error(`만들 수 없는 계정 이름 또는 비밀번호입니다: ${name}`);
      }
      await withSystemConnection(async (conn) => {
        await conn.execute(`CREATE USER ${name} IDENTIFIED BY "${pw}" QUOTA UNLIMITED ON USERS`);
        await conn.execute(`GRANT CREATE SESSION, CREATE TABLE TO ${name}`);
      });
      return { user: name, password: pw };
    },
    async stop() {
      await container.stop();
      if (ownNetwork) {
        await network.stop();
      }
    },
  };
}
