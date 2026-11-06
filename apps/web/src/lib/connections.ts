import {
  type BoolFormat,
  type ConnectionDto,
  type CreateConnectionRequest,
  type DbKind,
  type DetectionWarning,
  type TablePrivilege,
  type UnusableTableSet,
} from '@qa/shared';

export const CONNECTIONS_KEY = ['connections'] as const;
export const connectionKey = (id: number) => ['connections', id] as const;
export const connectionSchedulersKey = (id: number) => ['connections', id, 'schedulers'] as const;

export const DB_KIND_LABELS: Record<DbKind, string> = {
  oracle: 'Oracle',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
};

/** DB 종류별 기본 포트 */
export const DEFAULT_PORTS: Record<DbKind, number> = {
  oracle: 1521,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
};

export const BOOL_FORMAT_LABELS: Record<BoolFormat, string> = {
  native: 'BOOLEAN 컬럼',
  '10': "'1' / '0'",
  YN: "'Y' / 'N'",
  TF: "'T' / 'F'",
};

export const PRIVILEGE_LABELS: Record<TablePrivilege, string> = {
  SELECT: '조회',
  INSERT: '추가',
  UPDATE: '수정',
  DELETE: '삭제',
};

export const DETECTION_WARNING_LABELS: Record<DetectionWarning, string> = {
  BOOL_FORMAT_MIXED: '불리언 컬럼에 형식이 다른 값이 섞여 있어 가장 많은 형식을 골랐습니다',
  BOOL_FORMAT_UNKNOWN_VALUE: '불리언 컬럼에 알아볼 수 없는 값이 있습니다',
};

export function unusableReason(set: UnusableTableSet): string {
  return set.reason === 'MISSING_TABLES'
    ? `필수 테이블이 없습니다: ${set.tables.join(', ')}`
    : `SCHED_NAME 컬럼이 없습니다(Quartz 1.x 스키마는 지원하지 않습니다): ${set.tables.join(', ')}`;
}

/** 연결 테스트 실패 원인별 다음 행동 (FR-CON-02) */
export const TEST_FAILURE_HINTS: Record<string, string> = {
  TARGET_UNREACHABLE:
    '호스트, 포트, 서비스 이름(SID)이 맞는지, 도구 서버에서 DB로 가는 방화벽이 열려 있는지 확인하세요.',
  TARGET_AUTH_FAILED:
    '계정과 비밀번호가 맞는지, 계정이 잠기거나 비밀번호가 만료되지 않았는지 확인하세요.',
  TARGET_TIMEOUT:
    'DB가 10초 안에 응답하지 않았습니다. 네트워크 경로와 DB 부하를 확인하고 다시 시도하세요.',
  TARGET_BUSY: '이 접속의 커넥션이 모두 사용 중입니다. 잠시 후 다시 시도하세요.',
  TARGET_ERROR: '접속은 됐지만 카탈로그를 읽지 못했습니다. 스키마 이름과 조회 권한을 확인하세요.',
};

/** `host:port/service`, `host:port:SID`, `host:port/database` */
export function describeAddress(
  conn: Pick<ConnectionDto, 'host' | 'port' | 'oracleServiceName' | 'oracleSid' | 'database'>,
): string {
  const host = conn.host.includes(':') ? `[${conn.host}]` : conn.host;
  if (conn.oracleServiceName) return `${host}:${conn.port}/${conn.oracleServiceName}`;
  if (conn.oracleSid) return `${host}:${conn.port}:${conn.oracleSid}`;
  return `${host}:${conn.port}${conn.database ? `/${conn.database}` : ''}`;
}

/** 접속 폼의 값. 입력 그대로의 문자열이며, 보낼 때 `toConnectionRequest`로 바꾼다 */
export interface ConnectionFormValues {
  name: string;
  dbType: DbKind;
  host: string;
  port: string;
  /** Oracle: 서비스 이름으로 붙을지 SID로 붙을지 */
  oracleMode: 'service' | 'sid';
  oracleName: string;
  database: string;
  schemaName: string;
  username: string;
  password: string;
  envLabel: string;
  /** 쉼표로 구분 */
  tags: string;
  readOnly: boolean;
}

export const EMPTY_CONNECTION_FORM: ConnectionFormValues = {
  name: '',
  dbType: 'oracle',
  host: '',
  port: String(DEFAULT_PORTS.oracle),
  oracleMode: 'service',
  oracleName: '',
  database: '',
  schemaName: '',
  username: '',
  password: '',
  envLabel: 'dev',
  tags: '',
  readOnly: false,
};

export function connectionFormValues(conn: ConnectionDto): ConnectionFormValues {
  return {
    name: conn.name,
    dbType: conn.dbType,
    host: conn.host,
    port: String(conn.port),
    oracleMode: conn.oracleSid ? 'sid' : 'service',
    oracleName: conn.oracleSid ?? conn.oracleServiceName ?? '',
    database: conn.database ?? '',
    schemaName: conn.schemaName ?? '',
    username: conn.username,
    // 비밀번호는 응답에 없다. 비워 두면 서버가 기존 값을 쓴다 (FR-CON-05)
    password: '',
    envLabel: conn.envLabel,
    tags: conn.tags.join(', '),
    readOnly: conn.readOnly,
  };
}

/** 폼 값 → API 요청. 검증은 서버와 같은 zod 스키마로 한다 */
export function toConnectionRequest(values: ConnectionFormValues): CreateConnectionRequest {
  const oracle = values.dbType === 'oracle';
  return {
    name: values.name,
    dbType: values.dbType,
    host: values.host,
    port: values.port.trim() === '' ? Number.NaN : Number(values.port),
    oracleServiceName: oracle && values.oracleMode === 'service' ? values.oracleName : '',
    oracleSid: oracle && values.oracleMode === 'sid' ? values.oracleName : '',
    database: oracle ? '' : values.database,
    schemaName: values.schemaName,
    username: values.username,
    password: values.password,
    envLabel: values.envLabel,
    tags: values.tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
    readOnly: values.readOnly,
  };
}

/** 서버 스키마의 필드 경로 → 폼 입력 이름 */
export function formFieldOf(path: string): keyof ConnectionFormValues | undefined {
  const head = path.split('.')[0] ?? '';
  if (head === 'oracleServiceName' || head === 'oracleSid') return 'oracleName';
  const fields: (keyof ConnectionFormValues)[] = [
    'name',
    'dbType',
    'host',
    'port',
    'database',
    'schemaName',
    'username',
    'password',
    'envLabel',
    'tags',
    'readOnly',
  ];
  return fields.find((f) => f === head);
}

/** 쓰기 권한 표시 (FR-CON-04). 사용자가 읽기 전용으로 지정했으면 그쪽이 먼저다 */
export function writeStatus(conn: Pick<ConnectionDto, 'readOnly' | 'writeCapable'>): {
  label: string;
  tone: 'success' | 'warning' | 'neutral';
} {
  if (conn.readOnly) return { label: '읽기 전용(지정)', tone: 'neutral' };
  if (conn.writeCapable === null) return { label: '감지 전', tone: 'neutral' };
  return conn.writeCapable
    ? { label: '쓰기 가능', tone: 'success' }
    : { label: '읽기 전용(권한 없음)', tone: 'warning' };
}

/** 밀리초를 사람이 읽는 초·분 단위로 */
export function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}분`;
  if (ms % 1_000 === 0) return `${ms / 1_000}초`;
  return `${ms}ms`;
}
