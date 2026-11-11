import mysql from 'mysql2/promise';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

/** MySQL 버전. `QA_IT_MYSQL_VERSION`으로 바꾼다(예: 5.7). 이미지는 `mysql:<버전>` */
export const MYSQL_VERSION = process.env.QA_IT_MYSQL_VERSION ?? '8.4';
/** MariaDB 버전. `QA_IT_MARIADB_VERSION`으로 바꾼다(예: 10.3). 이미지는 `mariadb:<버전>` (B-29) */
export const MARIADB_VERSION = process.env.QA_IT_MARIADB_VERSION ?? '11.4';

/** MySQL 계열 서버 종류 */
export type MysqlFlavor = 'mysql' | 'mariadb';

const MYSQL_PORT = 3306;
const DATABASE = 'quartz';
// 테스트 컨테이너 전용 계정이다. 외부로 노출되지 않는다
const ROOT_PASSWORD = 'QaRoot_test1';

export interface StartMysqlOptions {
  /** 기본 `mysql` */
  flavor?: MysqlFlavor;
  network?: StartedNetwork;
  /** 기본 `mysql:<MYSQL_VERSION>` 또는 `mariadb:<MARIADB_VERSION>` */
  image?: string;
  /** 네트워크 안 호스트 이름. 기본은 flavor 이름 */
  alias?: string;
  /** 앱 계정(quartz DB에 모든 권한). 기본 `quartz` */
  user?: string;
  password?: string;
  /** `lower_case_table_names=1` 서버(테이블 이름을 소문자로 저장). 초기화 때만 정할 수 있다 */
  lowerCaseTableNames?: boolean;
}

export interface MysqlCredentials {
  user: string;
  password: string;
}

export interface MysqlFixture {
  readonly flavor: MysqlFlavor;
  /** describe 제목용(`MySQL 8.4`, `MariaDB 11.4`) */
  readonly label: string;
  readonly container: StartedTestContainer;
  readonly network: StartedNetwork;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** 같은 Docker 네트워크의 테스트베드가 쓰는 JDBC URL */
  readonly jdbcUrl: string;
  readonly user: string;
  readonly password: string;
  /** mysql2 커넥션. 큰 정수는 number로 읽는다(제품 어댑터와 같음). 닫는 것은 호출한 쪽 책임이다 */
  connect(credentials?: MysqlCredentials): Promise<mysql.Connection>;
  /** root로 접속한다(계정·권한 준비용) */
  connectRoot(): Promise<mysql.Connection>;
  /** root 계정(전역 권한이 있어야 하는 확인용) */
  readonly root: MysqlCredentials;
  /** 권한 없는 계정을 하나 더 만든다. 권한은 테스트가 테이블마다 준다 */
  createUser(user: string, password: string): Promise<MysqlCredentials>;
  stop(): Promise<void>;
}

export async function startMysql(options: StartMysqlOptions = {}): Promise<MysqlFixture> {
  const flavor = options.flavor ?? 'mysql';
  const ownNetwork = options.network === undefined;
  const network = options.network ?? (await new Network().start());
  const alias = options.alias ?? flavor;
  const user = options.user ?? 'quartz';
  const password = options.password ?? 'Quartz_test1';
  const image =
    options.image ??
    (flavor === 'mariadb'
      ? (process.env.QA_IT_MARIADB_IMAGE ?? `mariadb:${MARIADB_VERSION}`)
      : (process.env.QA_IT_MYSQL_IMAGE ?? `mysql:${MYSQL_VERSION}`));

  let container = new GenericContainer(image)
    .withNetwork(network)
    .withNetworkAliases(alias)
    .withExposedPorts(MYSQL_PORT)
    .withEnvironment({
      MYSQL_ROOT_PASSWORD: ROOT_PASSWORD,
      MYSQL_DATABASE: DATABASE,
      MYSQL_USER: user,
      MYSQL_PASSWORD: password,
    })
    // 초기화용 임시 서버는 port: 0으로, 실제 서버는 port: 3306으로 준비를 알린다(X Plugin의 33060은 제외).
    // MariaDB 이미지도 MYSQL_* 변수와 같은 로그 형식을 쓴다
    .withWaitStrategy(Wait.forLogMessage(/port: 3306\s/))
    .withStartupTimeout(180_000);
  if (options.lowerCaseTableNames) {
    container = container.withCommand(['--lower-case-table-names=1']);
  }
  const started = await container.start();

  const host = started.getHost();
  const port = started.getMappedPort(MYSQL_PORT);
  const open = (u: string, pw: string, database: string | undefined = DATABASE) =>
    mysql.createConnection({
      host,
      port,
      user: u,
      password: pw,
      ...(database ? { database } : {}),
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: true,
      dateStrings: true,
      timezone: 'Z',
    });

  return {
    flavor,
    label: flavor === 'mariadb' ? `MariaDB ${MARIADB_VERSION}` : `MySQL ${MYSQL_VERSION}`,
    container: started,
    network,
    host,
    port,
    database: DATABASE,
    jdbcUrl:
      flavor === 'mariadb'
        ? `jdbc:mariadb://${alias}:${MYSQL_PORT}/${DATABASE}`
        : `jdbc:mysql://${alias}:${MYSQL_PORT}/${DATABASE}?useSSL=false&allowPublicKeyRetrieval=true`,
    user,
    password,
    connect: (c = { user, password }) => open(c.user, c.password),
    connectRoot: () => open('root', ROOT_PASSWORD),
    root: { user: 'root', password: ROOT_PASSWORD },
    async createUser(name, pw) {
      if (!/^[a-z][a-z0-9_]*$/.test(name) || pw.includes("'")) {
        throw new Error(`만들 수 없는 계정 이름 또는 비밀번호입니다: ${name}`);
      }
      const root = await open('root', ROOT_PASSWORD);
      try {
        await root.query(`CREATE USER '${name}'@'%' IDENTIFIED BY '${pw}'`);
      } finally {
        await root.end();
      }
      return { user: name, password: pw };
    },
    async stop() {
      await started.stop();
      if (ownNetwork) await network.stop();
    },
  };
}
