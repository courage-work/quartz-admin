import oracledb from 'oracledb';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

export interface OracleEdition {
  /** describe 제목에 붙이는 이름 */
  readonly label: string;
  readonly image: string;
  /** 앱 계정을 만드는 PDB의 서비스 이름 */
  readonly serviceName: string;
  /** BOOLEAN 컬럼 타입이 있는지(23부터). Quartz 2.5.x의 `tables_oracle23.sql` 스키마를 만들 수 있다 */
  readonly nativeBoolean: boolean;
}

/**
 * 테스트하는 Oracle 버전. `QA_IT_ORACLE_VERSION`으로 고른다.
 * - `23`(기본): Oracle Free 23. gvenzl 이미지는 amd64와 arm64를 함께 제공해 Apple Silicon에서도 에뮬레이션 없이 돈다
 * - `21`: Oracle XE 21. amd64 전용이라 CI(x64 러너)와 x64 PC에서 돌린다
 */
export const ORACLE_EDITIONS: Readonly<Record<string, OracleEdition>> = {
  '23': {
    label: 'Oracle Free 23',
    image: 'gvenzl/oracle-free:23-slim-faststart',
    serviceName: 'FREEPDB1',
    nativeBoolean: true,
  },
  '21': {
    label: 'Oracle XE 21',
    image: 'gvenzl/oracle-xe:21-slim-faststart',
    serviceName: 'XEPDB1',
    nativeBoolean: false,
  },
};

export const ORACLE_VERSION = process.env.QA_IT_ORACLE_VERSION ?? '23';

/** 테스트하는 Oracle에 BOOLEAN 타입이 있는지. 모르는 버전이면 false(Oracle을 띄울 때 실패한다) */
export const ORACLE_NATIVE_BOOLEAN = ORACLE_EDITIONS[ORACLE_VERSION]?.nativeBoolean ?? false;

/** {@link ORACLE_VERSION}의 이미지·서비스 이름. 모르는 버전이면 Oracle을 쓰는 시점에 실패한다 */
export function oracleEdition(): OracleEdition {
  const edition = ORACLE_EDITIONS[ORACLE_VERSION];
  if (!edition) {
    throw new Error(
      `QA_IT_ORACLE_VERSION=${ORACLE_VERSION}은 지원하지 않습니다. ${Object.keys(ORACLE_EDITIONS).join(', ')} 중에서 고르세요`,
    );
  }
  return edition;
}

const ORACLE_PORT = 1521;
// 테스트 컨테이너 전용 계정이다. 외부로 노출되지 않는다
const SYSTEM_PASSWORD = 'QaSystem_23';

export interface StartOracleOptions {
  /** 테스트베드 노드와 같은 네트워크에 둘 때 넘긴다. 없으면 새로 만든다 */
  network?: StartedNetwork;
  /** 기본은 {@link oracleEdition}()의 이미지. `QA_IT_ORACLE_IMAGE`로도 바꿀 수 있다(서비스 이름은 버전을 따른다) */
  image?: string;
  /** 네트워크 안에서 쓰는 호스트 이름. 기본 `oracle` */
  alias?: string;
  /** 앱 계정(PDB에 생성). 기본 `QUARTZ` */
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
  readonly edition: OracleEdition;
  /** 앱 계정이 있는 PDB의 서비스 이름(`FREEPDB1`, `XEPDB1`) */
  readonly serviceName: string;
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
  /** SYSTEM 계정으로 PDB에 접속해 실행한다(계정·권한 준비용) */
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
  const edition = oracleEdition();
  const image = options.image ?? process.env.QA_IT_ORACLE_IMAGE ?? edition.image;
  const serviceName = edition.serviceName;

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

  const connectString = `${container.getHost()}:${container.getMappedPort(ORACLE_PORT)}/${serviceName}`;

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
    edition,
    serviceName,
    connectString,
    jdbcUrl: `jdbc:oracle:thin:@//${alias}:${ORACLE_PORT}/${serviceName}`,
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
