# quartz-admin TRD (기술 요구사항 문서)

| 항목 | 내용 |
| --- | --- |
| 문서 버전 | v0.1 (초안) |
| 작성일 | 2026-11-05 |
| 상태 | 검토 중 |
| 상위 문서 | PRD(`docs/PRD.md`) v0.3 |
| 후속 문서 | 백로그(`docs/BACKLOG.md`) |

이 문서는 PRD의 요구사항을 어떻게 구현할지 정합니다. 요구사항 ID(FR-*, NFR-*)는 PRD를 따릅니다.

---

## 1. 기술 결정 요약

| 영역 | 결정 | 근거 |
| --- | --- | --- |
| 런타임 | Node.js 24 LTS, TypeScript 6.0 (strict) | better-sqlite3 같은 네이티브 모듈의 사전 빌드 지원이 안정적. TypeScript 7은 typescript-eslint 8.x가 지원하지 않아(<6.1) 보류 |
| 모듈 방식 | 전체 ESM (`"type": "module"`, `module: NodeNext`) | NestJS 12가 ESM 전용. 상대 import에는 `.js` 확장자를 붙임 |
| 레포 구조 | pnpm workspace 모노레포 + Turborepo, 버전은 pnpm catalog로 한 곳에서 관리 | UI, API, 공유 타입, Quartz 로직을 패키지로 분리해 단독 테스트 |
| 관리 UI | Next.js 16(App Router) 정적 export(SPA) | 단일 컨테이너, 같은 오리진 |
| UI 구성 | shadcn/ui(Radix + Tailwind), TanStack Query, TanStack Table(가상 스크롤), react-hook-form + zod | 관리 화면에 필요한 표, 폼, 대화상자를 빠르게 구성 |
| API | NestJS 12, REST(`/api/v1`), zod 스키마 공유(nestjs-zod), OpenAPI 자동 생성 | 1인 개발에서 타입을 한 곳에서만 관리 |
| 메타데이터 저장소 | SQLite(better-sqlite3) + Drizzle ORM, drizzle-kit 마이그레이션 | 설계 검토 결정. 나중에 PostgreSQL로 전환 가능 |
| 대상 DB 드라이버 | `oracledb`(Thin 모드), `pg`, `mysql2`(MySQL과 MariaDB 공용) | ORM을 쓰지 않고 `QuartzDialect`로 차이를 흡수 |
| cron 계산 | Quartz `CronExpression`을 TypeScript로 이식, 타임존은 Luxon | Quartz와 결과가 같아야 함(PRD R2) |
| 판정 기준 시각 | 대상 DB 현재 시각 | 도구 서버 시계 오차로 인한 오탐 방지(PRD Q5) |
| 인증 | 로컬 계정, argon2id(`@node-rs/argon2`), 서버 측 세션 | PRD FR-USR |
| 알림 채널 | 인앱, Slack Incoming Webhook, SMTP(nodemailer) | PRD Q6 |
| 로깅 | pino(nestjs-pino), JSON, 민감 필드 마스킹 | NFR-OPS-03, NFR-SEC-03 |
| 테스트 | Vitest 5(단위, API는 데코레이터 메타데이터를 위해 unplugin-swc 사용), Testcontainers + Java Quartz 테스트베드(통합), Playwright(E2E) | 실제 Quartz 클러스터에서 제어 결과 검증 |
| 배포 | Docker 단일 컨테이너, Docker Compose, `/data` 볼륨 | NFR-OPS-01 |

## 2. 시스템 구성

```
┌────────────────────────── Docker 컨테이너 (단일 프로세스) ──────────────────────────┐
│                                                                                      │
│  NestJS                                                                              │
│  ├─ 정적 파일 서빙 (Next.js export 결과물)                                           │
│  ├─ REST API /api/v1 ──┬─ Auth / Users / Audit                                       │
│  │                     ├─ Connections / Schedulers ──┐                               │
│  │                     └─ Quartz 조회·제어 ──────────┤                               │
│  ├─ Monitor (감시 루프) ─────────────────────────────┤                               │
│  ├─ Alerts / Notifier (발송 큐) ─→ Slack, SMTP       │                               │
│  │                                                   ▼                               │
│  │                                   @qa/store (QuartzDialect, 커넥션 풀 관리)       │
│  │                                        │ oracledb / pg / mysql2                   │
│  └─ Drizzle ─→ SQLite (/data/quartz-admin.db, WAL)  │                               │
└─────────────────────────────────────────────────────┼───────────────────────────────┘
                                                      ▼
                         대상 DB (Oracle / PostgreSQL / MySQL / MariaDB) ← Quartz 클러스터 노드
```

- 프로세스는 하나입니다. 감시 루프, 알림 발송, API가 같은 프로세스에서 돌아갑니다(NFR-REL-04).
- 브라우저는 같은 오리진의 `/api/v1`만 호출합니다. CORS가 필요 없습니다.

### 2.1 레포 구조

```
quartz-admin/
├─ apps/
│  ├─ web/                 # Next.js (output: 'export')
│  └─ api/                 # NestJS. 빌드 시 web 결과물을 public/으로 복사해 서빙
├─ packages/
│  ├─ shared/   (@qa/shared)  # zod 스키마, API DTO, 에러 코드, 상수
│  ├─ core/     (@qa/core)    # 순수 로직: cron 이식, 트리거 시각 계산, 상태 상수, Java TZ 매핑, properties 파서
│  └─ store/    (@qa/store)   # 대상 DB 접근: 드라이버 어댑터, QuartzDialect 4종, 자동 감지, 조회·명령
├─ tools/
│  └─ quartz-testbed/      # Java 17 + Quartz 2.3.2/2.5.x 테스트 앱, cron 테스트 벡터 생성기
├─ docker/                 # Dockerfile, compose.yaml, 테스트용 compose
└─ docs/                   # PRD, TRD, BACKLOG
```

의존 방향: `api → store → core`, `api → shared`, `web → shared`. `core`는 외부 I/O에 의존하지 않습니다.

### 2.2 Next.js 정적 export의 제약

- 런타임 ID가 들어가는 동적 라우트(`/schedulers/[id]`)는 정적 export로 만들 수 없습니다. 그래서 **ID를 쿼리 파라미터로 전달**합니다. 예: `/scheduler?id=12&tab=triggers`, `/connection?id=3`.
- 서버 컴포넌트에서 데이터를 가져오거나 Next 미들웨어를 쓰지 않습니다. 인증 확인은 클라이언트에서 `GET /api/v1/auth/me`로 합니다. 실제 접근 통제는 API가 맡습니다.
- NestJS는 `/api/*` 이외의 경로 중 파일이 없는 요청에 해당 HTML(`*.html`) 또는 `404.html`을 돌려줍니다.

## 3. 메타데이터 저장소 (SQLite)

### 3.1 운영 설정

- PRAGMA: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`
- 마이그레이션: `drizzle-kit generate`로 SQL을 만들어 레포에 커밋하고, 기동할 때 `migrate()`로 적용합니다(NFR-OPS-04).
- 백업: better-sqlite3 온라인 백업 API(`db.backup()`)를 매일 실행해 `/data/backups/`에 7개까지 보관합니다. 수동 백업 CLI(`node dist/cli backup`)도 제공합니다(NFR-REL-03).
- 단일 인스턴스 보장: 기동 시 `instance_lock` 행에 인스턴스 ID와 하트비트(10초 주기)를 기록합니다. 최근 30초 안에 갱신된 다른 인스턴스의 하트비트가 있으면 **기동을 거부**합니다(NFR-REL-04, §13 제안 6).

### 3.2 스키마

| 테이블 | 주요 컬럼 | 비고 |
| --- | --- | --- |
| `users` | id, username(unique), password_hash, is_admin, is_active, failed_login_count, locked_until, last_login_at, created_at, updated_at | |
| `sessions` | id(토큰의 SHA-256), user_id, ip, user_agent, created_at, last_seen_at, expires_at | 원본 토큰은 쿠키에만 존재 |
| `connections` | id, name, db_type, host, port, database, oracle_service_name, oracle_sid, schema_name, username, password_enc, options_json(SSL 등), env_label, tags_json, read_only(사용자 지정), write_capable(감지 결과), created_by, created_at, updated_at | |
| `schedulers` | id, connection_id(FK, cascade), table_prefix, table_names_json(실제 테이블명), sched_name, display_name, features_json(선택 컬럼·테이블 존재 여부), bool_format, misfire_threshold_ms(기본 60000), overdue_grace_ms(기본 60000), checkin_multiplier(기본 3), expected_node_count, poll_interval_sec(기본 60), muted_until, detected_at, created_at, updated_at | unique(connection_id, table_prefix, sched_name) |
| `scheduler_snapshots` | scheduler_id(PK), polled_at, db_now, clock_skew_ms, status, trigger_counts_json, node_json, executing_count, error_code, error_message, consecutive_failures | 대시보드 캐시(§8.4) |
| `known_nodes` | scheduler_id, instance_name, first_seen_at, last_seen_at, last_checkin_time, checkin_interval | 노드 이탈 판정용 |
| `trigger_observations` | scheduler_id, trigger_group, trigger_name, state, first_seen_at | BLOCKED 지속 시간 추적. 재시작 후에도 유지 |
| `alert_rules` | id, scheduler_id(FK, cascade), type, params_json, scope_json, severity, renotify_minutes, enabled | |
| `alert_rule_channels` | rule_id, channel_id | N:M |
| `channels` | id, type(`inapp`/`slack`/`email`), name, config_enc(웹훅 URL, 수신자 등), enabled | 웹훅 URL도 비밀값으로 암호화 |
| `alerts` | id, scheduler_id, rule_id, fingerprint, type, severity, status(`open`/`acked`/`resolved`), affected_json, first_seen_at, last_seen_at, resolved_at, acked_by, acked_at, last_notified_at | 열린 알림은 (rule_id, fingerprint)당 하나 |
| `alert_reads` | alert_id, user_id, read_at | 인앱 읽음 처리 |
| `notifications` | id, alert_id, channel_id, event(`fire`/`update`/`resolve`/`reminder`), status, attempts, next_attempt_at, last_error, created_at | 발송 큐(outbox) |
| `audit_logs` | id, at, user_id, username, ip, request_id, action, target_type, target_json, connection_id, scheduler_id, before_json, after_json, result(`pending`/`success`/`failure`), error_code, error_message, reason | 앱에서는 INSERT와 result 갱신만 수행 |
| `settings` | key, value | 내부 설정값, 인스턴스 락 |

### 3.3 보존 정책

매일 새벽에 실행하는 정리 작업입니다.

| 대상 | 기본 보존 기간 | 설정 |
| --- | --- | --- |
| `audit_logs` | 365일 | `QA_AUDIT_RETENTION_DAYS` (PRD FR-AUD-04) |
| 해소된 `alerts`, `notifications` | 90일 | `QA_ALERT_RETENTION_DAYS` |
| 만료된 `sessions` | 즉시 | |

## 4. 보안

### 4.1 자격증명 암호화 (NFR-SEC-01, FR-CON-06)

- 알고리즘은 AES-256-GCM이고, 메시지마다 96비트 난수 IV를 씁니다.
- 저장 형식: `v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>`
- AAD에 `connections:<id>` 또는 `channels:<id>`를 넣어, 암호문을 다른 행으로 옮겨 붙이면 복호화가 실패하게 합니다.
- 키는 `QA_ENCRYPTION_KEYS=k1:<base64 32바이트>[,k2:...]`로 주입하고, `QA_ENCRYPTION_ACTIVE_KEY=k1`로 암호화에 쓸 키를 지정합니다. 키를 교체하면 CLI(`rotate-keys`)로 일괄 재암호화합니다.
- 키가 없거나 길이가 맞지 않으면 기동하지 않습니다.
- API 응답에는 비밀번호 필드가 아예 없습니다. 수정 요청에서 `password`를 빼면 기존 값을 유지합니다(FR-CON-05).

### 4.2 인증과 세션 (FR-USR)

- 비밀번호는 argon2id로 해시합니다(memory 19MiB, iterations 2, parallelism 1, OWASP 권장값).
- 세션 쿠키 `qa_sid`는 32바이트 난수이며 `HttpOnly; Secure; SameSite=Strict; Path=/`로 설정합니다. 로컬 HTTP 개발 환경에서만 `Secure`를 끕니다.
- 유휴 만료는 30분(`QA_SESSION_IDLE_MIN`), 절대 만료는 12시간입니다.
- 로그인 실패가 5회 이어지면 계정을 15분 동안 잠급니다. 로그인 API는 IP당 분당 10회로 제한합니다.
- 초기 관리자: `users` 테이블이 비어 있을 때만 `QA_ADMIN_USERNAME`과 `QA_ADMIN_PASSWORD`로 관리자를 만듭니다.
- 인증 계층은 `AuthProvider` 인터페이스(`authenticate(credentials) → UserIdentity`) 뒤에 둡니다. 후속 OIDC 지원을 위한 구조입니다(FR-USR-06).

### 4.3 웹 보안 (NFR-SEC-04)

- CSRF: 상태를 바꾸는 요청(POST/PUT/PATCH/DELETE)은 `Origin` 헤더가 `QA_PUBLIC_URL`과 같고 `X-QA-Request: 1` 헤더가 있어야 받습니다. `SameSite=Strict`와 함께 이중으로 방어합니다.
- helmet으로 CSP(`default-src 'self'`), `X-Content-Type-Options`, `Referrer-Policy` 등을 설정합니다.
- TLS는 앞단 리버스 프록시에서 종단하는 것을 기본으로 합니다. 이때 `QA_TRUST_PROXY=1`로 실제 클라이언트 IP를 감사 로그에 남깁니다.

### 4.4 대상 DB 접근 통제 (NFR-SEC-02)

- 대상 DB에 실행하는 SQL은 `@qa/store`에 정의된 쿼리뿐입니다. 사용자 입력(그룹명, 이름, 검색어)은 모두 바인드 변수로 넘깁니다.
- 테이블명은 자동 감지로 확정한 실제 이름만 쓰고, 항상 따옴표로 감쌉니다(§5.3).
- LIKE 검색어의 `%`, `_`, 이스케이프 문자는 이스케이프한 뒤 `ESCAPE` 절을 붙입니다.

## 5. 대상 DB 접근 계층 (`@qa/store`)

### 5.1 지원 범위 (NFR-COMP, PRD Q2·Q3 결정)

| DB | 최소 버전 | 드라이버 | 테스트 매트릭스 (CI) |
| --- | --- | --- | --- |
| Oracle | 12.1 | `oracledb` Thin 모드 (Instant Client 불필요) | Oracle XE 21, Oracle Free 23 |
| PostgreSQL | 11 | `pg` | 11, 17 |
| MySQL | 5.7 | `mysql2` | 5.7, 8.4 |
| MariaDB | 10.3 | `mysql2` | 10.3, 11.4 |

- Quartz 테스트 기준 버전은 **2.3.2**(사내 주력)와 **2.5.x 최신**입니다.
- Oracle 12.1, 18c, 19c용 공식 컨테이너가 없어 CI에서는 검증하지 못합니다. 대신 SQL을 12.1 문법(`OFFSET … FETCH`, `FOR UPDATE WAIT n`) 안에서만 쓰고, 출시 전에 사내 19c(가능하면 12c) 인스턴스로 수동 점검합니다.
- MySQL 5.7을 지원하므로 CTE, 윈도 함수, `SKIP LOCKED`/`NOWAIT`(8.0 이상)를 쓰지 않습니다.
- `mysql2`는 MariaDB 전용 인증 플러그인 `ed25519`를 지원하지 않습니다. 이 플러그인을 쓰는 계정은 접속 테스트에서 안내합니다. 필요하면 `mariadb` 커넥터용 어댑터를 따로 추가합니다.

### 5.2 커넥션 풀 관리 (NFR-PERF-04, NFR-REL-01)

`TargetPoolManager`가 접속(connection) 단위로 풀을 관리합니다. 같은 접속에 있는 스케줄러들은 풀을 함께 씁니다.

| 항목 | 값 |
| --- | --- |
| 최대 커넥션 | 2 |
| 생성 방식 | 처음 쓸 때 생성. 접속 정보가 바뀌면 풀을 폐기하고 다시 생성 |
| 유휴 종료 | 60초 |
| 연결 타임아웃 | 10초 |
| 커넥션 대기 타임아웃 | 10초 (초과 시 `TARGET_BUSY`) |
| 조회 쿼리 실행 제한 | 10초 (PG `statement_timeout`, MySQL `MAX_EXECUTION_TIME` 힌트, MariaDB `max_statement_time`, Oracle `callTimeout`) |
| 세션 보호 | PG `idle_in_transaction_session_timeout=30s`, TCP keepalive 사용 |

드라이버별 설정:

- **oracledb**: `fetchAsBuffer = [oracledb.BLOB]`, `outFormat = OUT_FORMAT_OBJECT`. NUMBER는 JS number로 받습니다(epoch ms는 2^53 미만).
- **pg**: 풀마다 `types` 옵션으로 int8(OID 20)을 Number로 파싱합니다. 전역 `setTypeParser`는 쓰지 않습니다.
- **mysql2**: `supportBigNumbers: true`, `bigNumberStrings: false`, `dateStrings: true`, `timezone: 'Z'`

### 5.3 QuartzDialect

```ts
type DbKind = 'oracle' | 'postgresql' | 'mysql' | 'mariadb';

interface QuartzDialect {
  readonly kind: DbKind;
  param(index: number): string;                 // ':1' | '$1' | '?'
  quote(ident: string): string;                 // "QRTZ_TRIGGERS" | `qrtz_triggers`
  paginate(sql: string, limitParam: number, offsetParam: number): string;
  forUpdate(waitSec: number): string;           // Oracle: 'FOR UPDATE WAIT 5', 그 외: 'FOR UPDATE'
  beforeLockedTx(conn: TargetConn, lockWaitSec: number): Promise<void>;
  afterLockedTx(conn: TargetConn): Promise<void>; // 세션 변수 원복
  dbNowMillisSql(): string;
  catalog: CatalogQueries;                      // 테이블, 컬럼, 권한 조회
  readBool(v: unknown): boolean | null;         // '1'/'0', 'Y'/'N', true/false, 1/0
  readBlob(v: unknown): Buffer | null;
  readLong(v: unknown): number | null;
}
```

| 동작 | Oracle | PostgreSQL | MySQL / MariaDB |
| --- | --- | --- | --- |
| 바인드 | `:1` | `$1` | `?` |
| 식별자 | `"QRTZ_TRIGGERS"` | `"qrtz_triggers"` (감지한 실제 대소문자) | `` `QRTZ_TRIGGERS` `` |
| 페이지네이션 | `OFFSET :n ROWS FETCH NEXT :m ROWS ONLY` | `LIMIT $m OFFSET $n` | `LIMIT ? OFFSET ?` |
| 잠금 대기 제한 | `FOR UPDATE WAIT 5`(락 행과 대상 행 모두) | `SET LOCAL lock_timeout = '5s'` | `SET SESSION innodb_lock_wait_timeout = 5` (트랜잭션 후 원복) |
| 격리 수준 | READ COMMITTED (기본값) | READ COMMITTED (기본값) | `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` |
| 현재 시각(ms) | `(CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE) - DATE '1970-01-01') * 86400000 + TO_NUMBER(TO_CHAR(SYSTIMESTAMP,'FF3'))` | `(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint` | `ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000)` |
| 카탈로그 | `ALL_TABLES`, `ALL_TAB_COLUMNS` (OWNER) | `information_schema` (table_schema) | `information_schema` (`DATABASE()`) |

Oracle에서는 DML이 행 잠금을 무기한 기다립니다. 그래서 대상 트리거 행도 `SELECT … FOR UPDATE WAIT 5`로 먼저 잠근 뒤 UPDATE합니다.

### 5.4 Quartz 테이블 접근 규칙

- 시각 컬럼(NEXT_FIRE_TIME 등)은 epoch ms입니다. Quartz는 값이 없으면 `NEXT_FIRE_TIME`/`PREV_FIRE_TIME`에 `-1`, `END_TIME`에 `0`을 저장하는데, 읽을 때 이를 `null`로 바꿉니다.
- 불리언 컬럼은 읽을 때만 정규화합니다. MVP의 쓰기 작업은 불리언 컬럼을 건드리지 않습니다(새로 넣는 행은 `TRIGGERS`와 `SIMPLE_TRIGGERS`뿐이고, 두 테이블에는 불리언 컬럼이 없음).
- JOB_DATA(BLOB)는 읽기만 합니다. 즉시 실행 트리거의 JOB_DATA는 `NULL`로 넣습니다. Quartz는 NULL을 빈 맵으로 처리합니다(통합 테스트로 확인).
- Oracle에서는 빈 문자열이 NULL이 되므로, DESCRIPTION 비교는 `IS NULL`과 함께 처리합니다.

### 5.5 자동 감지 (FR-CON-03, FR-CON-04)

1. **테이블 탐색**: 카탈로그에서 스키마의 테이블 목록을 읽습니다. 이름을 대문자로 바꿨을 때 `<prefix>TRIGGERS`로 끝나는 테이블마다 prefix 후보를 뽑습니다.
2. **필수 세트 확인**: prefix마다 아래 필수 테이블이 모두 있는지 대소문자 무시로 확인합니다. 있으면 실제 이름을 `table_names_json`에 기록합니다.
   - 필수: `JOB_DETAILS`, `TRIGGERS`, `SIMPLE_TRIGGERS`, `CRON_TRIGGERS`, `BLOB_TRIGGERS`, `CALENDARS`, `PAUSED_TRIGGER_GRPS`, `FIRED_TRIGGERS`, `SCHEDULER_STATE`, `LOCKS`
   - 선택: `SIMPROP_TRIGGERS`
3. **스키마 기능 감지**: 버전 차이가 나는 테이블과 컬럼(`SIMPROP_TRIGGERS` 테이블, `FIRED_TRIGGERS.SCHED_TIME`, `TRIGGERS.PRIORITY` 등)이 있는지 `features_json`에 기록합니다. 쿼리 빌더는 이 값에 따라 컬럼을 넣거나 뺍니다.
4. **불리언 형식 감지**: 컬럼 타입이 BOOL이면 `native`로 봅니다. 문자 타입이면 `JOB_DETAILS.IS_DURABLE`의 DISTINCT 값으로 `10`/`YN`/`TF` 중 하나를 판정합니다.
5. **SCHED_NAME 목록**: `TRIGGERS`, `JOB_DETAILS`, `SCHEDULER_STATE`, `LOCKS`에서 DISTINCT `SCHED_NAME`을 모아 후보로 제시합니다. 각 후보에 잡 수, 트리거 수, 활성 노드 수를 붙입니다.
6. **쓰기 권한 점검**: 트랜잭션 안에서 결과 행이 0개인 쓰기 문(`UPDATE … WHERE 1=0`, `INSERT … SELECT … WHERE 1=0`, `DELETE … WHERE 1=0`)을 실행한 뒤 ROLLBACK합니다. 권한 검사는 실행 단계에서 일어나므로 행을 건드리거나 잠그지 않고도 권한 유무를 판정할 수 있습니다. 하나라도 실패하면 `write_capable=false`로 둡니다.

   | 테이블 | 필요 권한 |
   | --- | --- |
   | TRIGGERS, SIMPLE_TRIGGERS | SELECT, INSERT, UPDATE, DELETE |
   | CRON_TRIGGERS | SELECT, UPDATE, DELETE |
   | SIMPROP_TRIGGERS, BLOB_TRIGGERS, JOB_DETAILS | SELECT, DELETE |
   | PAUSED_TRIGGER_GRPS | SELECT, INSERT, DELETE |
   | LOCKS | SELECT, INSERT, UPDATE |
   | FIRED_TRIGGERS, SCHEDULER_STATE, CALENDARS | SELECT |
7. **기대 노드 수 초기값**: 감지 시점의 활성 노드 수를 `expected_node_count` 초기값으로 씁니다(§9.2).

## 6. Quartz 로직 이식 (`@qa/core`)

### 6.1 범위

| 모듈 | 내용 | 원본 (Quartz 2.3.2) |
| --- | --- | --- |
| `cron/` | 파싱, 검증, `getTimeAfter`, 오류 메시지 | `org.quartz.CronExpression` |
| `triggers/cron` | `computeFirstFireTime`, `getFireTimeAfter`(start/end 반영) | `CronTriggerImpl` |
| `triggers/simple` | `computeFirstFireTime`, `getFireTimeAfter`, 반복 횟수 계산 | `SimpleTriggerImpl` |
| `states` | 트리거 상태, 타입, misfire 처리 방식 상수와 표시 이름 | `Constants`, `Trigger` |
| `tz` | Java TimeZone ID를 IANA ID로 변환(`GMT+09:00`, `EST` 같은 레거시 ID 포함) | `java.util.TimeZone` |
| `props` | Java `.properties` 형식 파서(ISO-8859-1, 유니코드 이스케이프) | `java.util.Properties` |

- Quartz는 Apache License 2.0입니다. 이식한 파일에는 원본 저작권 고지와 라이선스를 남기고, 루트에 `NOTICE`를 둡니다.
- misfire 처리 방식별 다음 실행 시각 계산(`updateAfterMisfire`)은 **이식하지 않습니다**. 재개할 때 발생하는 misfire는 Quartz 노드의 MisfireHandler에 맡깁니다(§7.4).

### 6.2 교차 검증

- `tools/quartz-testbed`의 `cron-vectors` 명령이 실제 Quartz로 테스트 벡터 JSON을 만듭니다. 벡터는 (cron 표현식, 타임존, 기준 시각) 조합마다 다음 실행 시각 20개입니다.
- 벡터에는 `L`, `LW`, `#`, `W`, 윤년, 월말, DST 전환(America/New_York, Europe/Berlin)과 Asia/Seoul을 포함하고, 조합은 300개 이상으로 잡습니다.
- 잘못된 표현식 목록에 대해서는 Quartz와 같이 거부하는지 검증합니다.
- 벡터 JSON은 레포에 커밋합니다. CI는 Java 없이 Vitest로 비교합니다.

## 7. 제어 명령 설계 (FR-CTL)

### 7.1 공통 실행 절차

모든 명령은 `QuartzCommandService.execute(schedulerId, command, actor)` 하나를 통해 실행됩니다.

```
1. 사전 검사: 읽기 전용 접속이 아닌지(FR-CTL-00a), write_capable인지
2. 도구 내부 직렬화: 스케줄러 단위 뮤텍스. 같은 스케줄러의 명령은 하나씩 실행
3. 감사 로그 INSERT (result=pending, before=명령 요청 내용)
4. 대상 DB 트랜잭션
   a. dialect.beforeLockedTx (격리 수준, 잠금 타임아웃)
   b. BEGIN
   c. 잠금 행 확보: SELECT * FROM {LOCKS} WHERE SCHED_NAME=? AND LOCK_NAME='TRIGGER_ACCESS' FOR UPDATE [WAIT 5]
      행이 없으면 INSERT 후 다시 SELECT (Quartz StdRowLockSemaphore와 같은 방식)
   d. 대상 재조회 후 expected와 비교. 다르면 ROLLBACK, 409 STATE_CONFLICT (FR-CTL-00e)
   e. 상태 조건부 변경 (§7.3)
   f. 변경 후 상태 조회
   g. COMMIT
   h. dialect.afterLockedTx
5. 감사 로그 갱신 (result=success|failure, after, error_code)
```

- 잠금 범위 안에서는 대상 DB 호출만 하고, 다른 비동기 작업(SQLite, 외부 호출)은 하지 않습니다. Quartz 노드를 기다리게 하는 시간을 최소화하기 위해서입니다(PRD R3).
- 잠금 대기가 5초를 넘으면 `LOCK_TIMEOUT`, 그 밖의 DB 오류는 `TARGET_ERROR`로 응답합니다. 어떤 실패든 ROLLBACK하므로 대상 DB에는 아무것도 바뀌지 않습니다.
- 도구 프로세스가 트랜잭션 도중 죽으면 커넥션이 끊기면서 DB가 ROLLBACK합니다(NFR-REL-02). 기동할 때 `pending` 상태로 남은 감사 로그를 `failure(INTERRUPTED)`로 정리하고, 화면에 "결과 확인 필요"를 표시합니다.

### 7.2 잠금 규약과 동시성 근거

- Quartz는 트리거 상태를 바꾸는 작업(pause/resume, storeTrigger, triggersFired, misfire 처리)을 `TRIGGER_ACCESS` 행 잠금 안에서 합니다. 도구도 같은 잠금을 씁니다.
- 기본 설정(`acquireTriggersWithinLock=false`, 배치 크기 1)에서는 트리거 획득(WAITING→ACQUIRED)이 잠금 없이 **상태 조건부 UPDATE**로 일어납니다. 그래서 도구의 모든 상태 변경도 반드시 `WHERE TRIGGER_STATE IN (기대 상태들)` 조건을 붙인 UPDATE로 합니다. 경합에서 ACQUIRED가 먼저 되더라도 Quartz와 마찬가지로 ACQUIRED→PAUSED로 처리되고, 이후 `triggersFired`는 상태가 ACQUIRED가 아니면 발화하지 않습니다.
- 잠금 순서는 항상 "잠금 행 → 대상 행"입니다. Quartz의 잠금 없는 획득 트랜잭션은 잠금 행을 기다리지 않으므로 교착 순환이 생기지 않습니다.
- 구현 전에 Quartz 2.3.2 `JobStoreSupport`와 `StdJDBCDelegate`를 보고 위 동작을 확인합니다(§12 스파이크 S1).

### 7.3 명령별 동작

Quartz 메서드와 같은 결과를 내는 것이 원칙입니다(FR-CTL-00d). 아래는 Quartz 2.3.2 기준이며 S1에서 소스로 다시 확인합니다.

| 명령 | 대응 Quartz API | 동작 |
| --- | --- | --- |
| `pauseTrigger` | `pauseTrigger` | WAITING/ACQUIRED → PAUSED, BLOCKED → PAUSED_BLOCKED |
| `resumeTrigger` | `resumeTrigger` | PAUSED → WAITING, PAUSED_BLOCKED → BLOCKED. 같은 잡에 `IS_NONCONCURRENT` 실행 기록(FIRED_TRIGGERS)이 있으면 BLOCKED로 둠. NEXT_FIRE_TIME은 바꾸지 않음(§7.4) |
| `pauseJob` / `resumeJob` | `pauseJob` / `resumeJob` | 잡의 모든 트리거에 위 동작 적용 |
| `pauseTriggerGroup` | `pauseTriggers(GroupMatcher.equals)` | 그룹 트리거 일괄 상태 전이 후 `PAUSED_TRIGGER_GRPS`에 INSERT(없을 때) |
| `resumeTriggerGroup` | `resumeTriggers(...)` | `PAUSED_TRIGGER_GRPS`에서 DELETE 후 그룹 트리거 각각 resume |
| `pauseJobGroup` / `resumeJobGroup` | `pauseJobs` / `resumeJobs` | 그룹 내 잡별 pause/resume. JDBC JobStore는 잡 그룹 일시정지를 저장하지 않으므로, 이후 추가되는 잡에는 적용되지 않음(화면에 안내) |
| `pauseAll` / `resumeAll` (P1) | `pauseAll` / `resumeAll` | 모든 트리거 그룹 pause와 `_$_ALL_GROUPS_PAUSED_$_` INSERT. 재개는 그 역순 |
| `triggerJob` | `triggerJob(jobKey)` | §7.5 |
| `updateCronSchedule` | `rescheduleJob` 상당 | §7.6 |
| `updateSimpleSchedule` | `rescheduleJob` 상당 | §7.6 |
| `deleteTrigger` | `unscheduleJob` | 하위 테이블(SIMPLE/CRON/SIMPROP/BLOB) 행과 TRIGGERS 행 삭제. 잡이 durable이 아니고 남은 트리거가 0개면 잡도 삭제 |
| `deleteJob` | `deleteJob` | 잡의 모든 트리거와 하위 행, JOB_DETAILS 삭제. 삭제 전 스냅샷을 감사 로그 `before_json`에 저장(JOB_DATA는 64KB까지 base64) |

명령 요청 형식(zod 판별 유니온):

```ts
type Command =
  | { type: 'pauseTrigger' | 'resumeTrigger' | 'deleteTrigger'; trigger: Key; expected: TriggerExpect }
  | { type: 'pauseJob' | 'resumeJob' | 'deleteJob' | 'triggerJob'; job: Key; expected: JobExpect }
  | { type: 'pauseTriggerGroup' | 'resumeTriggerGroup'; group: string }
  | { type: 'pauseJobGroup' | 'resumeJobGroup'; group: string }
  | { type: 'updateCronSchedule'; trigger: Key; cron: string; timeZone: string; expected: TriggerExpect }
  | { type: 'updateSimpleSchedule'; trigger: Key; repeatIntervalMs: number; repeatCount: number; startAt?: number; expected: TriggerExpect };
// Key = { group: string; name: string }
// TriggerExpect = { state: TriggerState; nextFireTime: number | null }
```

- `POST /schedulers/:id/commands/preview`: 같은 요청을 받아 영향 범위(대상 트리거 목록과 개수, 경고)만 계산하고 아무것도 바꾸지 않습니다. 확인 대화상자가 이 응답을 표시합니다(FR-CTL-00b).
- 경고 예: 동시 실행 금지 잡이 실행 중, 활성 노드 0개, 마지막 트리거 삭제로 잡도 삭제됨, 실행 중인 잡 삭제

### 7.4 재개 시 misfire 처리 (FR-CTL-04)

재개할 때 NEXT_FIRE_TIME이 이미 지났더라도, 도구는 상태만 바꾸고 다음 실행 시각은 다시 계산하지 않습니다.

- Quartz 노드의 MisfireHandler가 `NEXT_FIRE_TIME < now - misfireThreshold`인 WAITING 트리거를 주기적으로 찾아, 각 트리거의 misfire 처리 방식과 캘린더를 반영해 다시 계산합니다.
- 임계값 안이면 일반 획득 경로로 바로 발화합니다. 결과는 Quartz `resumeTrigger`와 같고, 차이는 적용 시점이 수 초 늦을 수 있다는 것뿐입니다.
- 이렇게 하면 misfire 처리 방식(SimpleTrigger만 6종)과 Java 직렬화된 캘린더를 이식하지 않아도 됩니다.
- 활성 노드가 없으면 노드가 다시 뜰 때까지 반영되지 않습니다. Quartz도 스케줄러가 멈춰 있으면 misfire를 처리하지 않으므로 같은 결과입니다.
- 화면에는 "재개됨. 지난 실행은 Quartz 노드가 misfire 정책에 따라 처리합니다"라고 안내합니다.
- PRD v0.3 FR-CTL-04에 반영했습니다(§13 제안 1).

### 7.5 즉시 실행 (FR-CTL-05)

Quartz `triggerJob`과 같은 형태의 일회성 트리거를 INSERT합니다.

| 컬럼 | 값 |
| --- | --- |
| TRIGGER_NAME | `MT_` + 난수(Quartz와 같은 접두어). 충돌하면 다시 생성 |
| TRIGGER_GROUP | `DEFAULT` |
| DESCRIPTION | `quartz-admin: <사용자명>` (추적용) |
| TRIGGER_TYPE | `SIMPLE` (+ `SIMPLE_TRIGGERS`: REPEAT_COUNT 0, REPEAT_INTERVAL 0, TIMES_TRIGGERED 0) |
| START_TIME, NEXT_FIRE_TIME | 대상 DB 현재 시각 |
| PREV_FIRE_TIME / END_TIME | -1 / 0 |
| PRIORITY / MISFIRE_INSTR | 5 / 0 |
| JOB_DATA, CALENDAR_NAME | NULL |
| TRIGGER_STATE | Quartz `storeTrigger` 규칙: 기본 WAITING. `DEFAULT` 그룹이나 전체 일시정지가 걸려 있으면 PAUSED, 동시 실행 금지 잡이 실행 중이면 BLOCKED/PAUSED_BLOCKED |

트리거는 한 번 발화하면 Quartz가 COMPLETE로 처리하고 삭제합니다.

### 7.6 스케줄 수정 (FR-CTL-06, FR-CTL-07)

- **CRON**: `CRON_TRIGGERS`의 CRON_EXPRESSION과 TIME_ZONE_ID를 바꾸고, `TRIGGERS.NEXT_FIRE_TIME`을 `getFireTimeAfter(max(dbNow, START_TIME - 1000))`으로 다시 계산합니다(END_TIME 반영). 결과가 null이면(더 이상 발화하지 않음) 거부합니다.
- **SIMPLE**: REPEAT_INTERVAL과 REPEAT_COUNT를 바꾸고, TIMES_TRIGGERED=0, START_TIME=`startAt`(기본은 DB 현재 시각), NEXT_FIRE_TIME=START_TIME으로 둡니다. "지금부터 새 간격으로 다시 시작"하는 의미입니다.
- **상태 유지**: 트리거 상태는 바꾸지 않습니다. 개별로 일시정지된 트리거는 수정 후에도 PAUSED입니다. Quartz `rescheduleJob`은 트리거를 지우고 새로 저장하므로 개별 일시정지가 풀리는 것으로 알려져 있습니다(S1에서 확인). 운영자의 기대에 맞추기 위한 **의도된 차이**이며, §13 제안 5입니다.
- **캘린더 연결 트리거**: CALENDAR_NAME이 있는 트리거는 수정할 수 없습니다. 캘린더는 Java 직렬화 BLOB이라 제외 시간을 계산할 수 없기 때문입니다(§13 제안 2).
- **미리보기**: `POST /cron/preview { expression, timeZone, count: 5 }`가 `@qa/core`로 계산합니다. 화면은 입력할 때마다(300ms 디바운스) 호출합니다.

## 8. 조회 설계 (FR-VIEW)

### 8.1 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/schedulers` | 대시보드 목록. 스냅샷 캐시 기반(§8.4). `env`, `tag`, `q` 필터 |
| GET | `/schedulers/:id` | 상세. 스냅샷과 설정 |
| GET | `/schedulers/:id/nodes` | 실시간 노드 목록 |
| GET | `/schedulers/:id/paused-groups` | 일시정지된 트리거 그룹 |
| GET | `/schedulers/:id/jobs` | `group`, `q`, `page`, `size`(최대 200), `sort` |
| GET | `/schedulers/:id/jobs/detail?group=&name=` | 잡 상세, 트리거 목록, JobDataMap(가능한 경우) |
| GET | `/schedulers/:id/triggers` | `state[]`, `type[]`, `group`, `q`, `page`, `size`, `sort`(`key`/`nextFireTime`) |
| GET | `/schedulers/:id/executing` | FIRED_TRIGGERS 기반 실행 중 목록 |

- 잡과 트리거 키는 `/` 같은 문자를 포함할 수 있으므로 경로가 아니라 쿼리 파라미터로 받습니다.
- 목록은 OFFSET 페이지네이션입니다. 스케줄러당 트리거 10,000개 규모면 충분합니다.
- 상세 조회는 대상 DB에서 직접 읽고(타임아웃 10초), 응답에 `dbNow`를 넣어 화면이 데이터 기준 시각을 표시합니다(FR-VIEW-06).

### 8.2 주요 쿼리

- 트리거 목록: `TRIGGERS LEFT JOIN CRON_TRIGGERS LEFT JOIN SIMPLE_TRIGGERS` (+ `SIMPROP_TRIGGERS`가 있으면 표시용으로)
- 상태별 개수: `SELECT TRIGGER_STATE, COUNT(*) … GROUP BY TRIGGER_STATE`. Quartz 공식 스크립트의 `IDX_QRTZ_T_STATE` 인덱스를 씁니다. 인덱스가 없는 설치는 감지 단계에서 경고합니다.
- 검색: `UPPER(TRIGGER_NAME) LIKE UPPER(?) ESCAPE '\'`. 그룹명에도 같은 방식을 씁니다.

### 8.3 JobDataMap 표시 (FR-VIEW-08)

- BLOB이 `0xACED`(Java 직렬화 매직 넘버)로 시작하면 "Java 직렬화 형식이라 표시할 수 없음"으로 응답합니다.
- 그렇지 않으면 `@qa/core/props`로 파싱해 키-값 목록을 돌려줍니다. 비밀값이 들어 있을 수 있으므로 화면에서는 기본으로 값을 가리고, 펼치면 보이게 합니다.

### 8.4 대시보드 스냅샷

- 감시 루프(§9)가 주기마다 스케줄러별 요약(상태별 트리거 수, 노드, 실행 중 수, DB 시각, 시계 차이, 오류)을 `scheduler_snapshots`에 저장합니다.
- 대시보드는 대상 DB를 직접 조회하지 않고 이 캐시만 읽습니다. 그래서 연결할 수 없는 DB가 있어도 응답 시간이 일정합니다(NFR-PERF-01, FR-VIEW-07).
- 도구 서버와 대상 DB의 시계 차이가 30초를 넘으면 스케줄러 카드에 경고를 표시합니다.

## 9. 감시와 알림 (FR-ALT)

### 9.1 감시 루프

- NestJS 프로세스 안에서 스케줄러마다 `poll_interval_sec`(기본 60초)로 실행합니다. 시작 시점은 지터를 줘서 분산합니다.
- 동시에 실행하는 감시 작업은 최대 8개입니다(`QA_MONITOR_CONCURRENCY`).
- 한 번 감시할 때 실행하는 쿼리(대상 DB 왕복 4회 안팎):
  1. DB 현재 시각
  2. 상태별 트리거 수
  3. `SCHEDULER_STATE` 전체
  4. 연체 트리거 상위 50개, ERROR와 BLOCKED 트리거 목록(UNION 또는 개별 쿼리)
  5. FIRED_TRIGGERS 개수
- 결과는 스냅샷 저장, 규칙 평가, 알림 상태 갱신, 발송 큐 적재 순으로 처리합니다. SQLite 쓰기는 감시 1회당 트랜잭션 하나로 묶습니다.
- 감시 1회는 전체 30초를 넘기지 않습니다. 넘으면 그 회차는 실패로 처리합니다.
- 규모 추정: 스케줄러 100개 × 분당 5쿼리 = 대상 DB 전체에 분당 500쿼리. 스케줄러 하나가 놓인 DB에는 분당 5쿼리 수준입니다(NFR-PERF-03, PRD R7).

### 9.2 판정 규칙

모든 시각 비교는 같은 회차에 읽은 **대상 DB 현재 시각(`dbNow`)**을 기준으로 합니다.

| 규칙 타입 | 조건 | 지문(fingerprint) | 기본 심각도 |
| --- | --- | --- | --- |
| `OVERDUE` (FR-ALT-01) | `TRIGGER_STATE IN ('WAITING','ACQUIRED') AND NEXT_FIRE_TIME > 0 AND NEXT_FIRE_TIME < dbNow - (misfire_threshold_ms + overdue_grace_ms)` | 규칙 단위(대상 트리거 목록은 affected에 기록) | warning |
| `TRIGGER_ERROR` (FR-ALT-02) | `TRIGGER_STATE = 'ERROR'` | 규칙 단위 | critical |
| `BLOCKED_LONG` (FR-ALT-03) | `trigger_observations`에서 BLOCKED 상태가 처음 관찰된 지 `params.minutes`(기본 30)분 이상 | 규칙 단위 | warning |
| `NODE_MISSING` (FR-ALT-04) | 활성 노드 수 < `expected_node_count`. 활성 노드는 `LAST_CHECKIN_TIME + CHECKIN_INTERVAL × checkin_multiplier ≥ dbNow`인 노드 | 스케줄러 단위 | warning |
| `CLUSTER_DOWN` (FR-ALT-04) | 활성 노드 0개 | 스케줄러 단위 | critical |
| `MONITOR_UNREACHABLE` (FR-ALT-05) | 감시가 연속 `params.failures`(기본 3)회 실패 | 스케줄러 단위 | critical |

- **노드 이탈을 기대 노드 수로 판정하는 이유**: 클러스터에 살아남은 노드가 있으면, 그 노드의 ClusterManager가 죽은 노드를 복구한 뒤 `SCHEDULER_STATE`에서 해당 행을 지웁니다. 그러면 체크인 시각만 보는 방식은 감시 주기(60초) 안에 사라진 행을 놓칩니다. 또 `instanceId=AUTO`를 쓰면 재시작할 때마다 인스턴스명이 바뀝니다. 그래서 "기대 노드 수보다 적음"을 기본 신호로 쓰고, 체크인이 오래된 행은 보조 신호로 affected에 표시합니다. 기대 노드 수는 스케줄러 설정에서 바꿀 수 있습니다(§13 제안 4).
- **연체 판정**: 정상 클러스터에서는 MisfireHandler가 misfire된 트리거의 NEXT_FIRE_TIME을 곧 갱신합니다. 따라서 연체 상태가 이어진다는 것은 클러스터가 트리거를 처리하지 못한다는 뜻입니다(노드 다운, 스레드 풀 고갈 등). "misfire가 처리되어 실행을 건너뛴 경우"는 DB에 흔적이 남지 않아 MVP에서 감지하지 못합니다. 스냅샷 비교 방식은 Phase 2에서 검토합니다.
- **적용 범위**: 규칙의 `scope_json`(`all` | `groups[]` | `triggers[]`)을 쿼리 조건에 반영합니다.
- **기본 규칙 세트**: 스케줄러를 등록하면 위 6종을 기본값으로 만들고, 인앱 채널에 연결합니다.

### 9.3 알림 수명주기 (FR-ALT-08, FR-ALT-09)

```
조건 성립 ──(열린 알림 없음)──> open 생성 → fire 발송
조건 성립 ──(open/acked 있음)──> last_seen 갱신
                                  affected에 새 항목 추가 시 update 발송
                                  renotify_minutes 경과 시 reminder 발송
조건 해소 ──────────────────────> resolved → resolve 발송
사용자 확인 ────────────────────> acked (reminder 중지, 해소 알림은 발송)
```

- **억제**: `CLUSTER_DOWN`이나 `MONITOR_UNREACHABLE`이 열려 있으면, 같은 스케줄러의 `OVERDUE`, `BLOCKED_LONG`, `NODE_MISSING`은 평가는 하되 발송하지 않습니다(FR-ALT-09).
- **요약**: 한 회차에 같은 채널로 나갈 발송이 5건을 넘으면 요약 메시지 하나로 묶습니다.
- **음소거**(P1): `muted_until`이 지나지 않았으면 알림 상태는 기록하되 발송하지 않습니다.
- **재시작**: 알림 상태와 `trigger_observations`는 SQLite에 있으므로 재시작해도 그대로 이어집니다.

### 9.4 발송 (FR-ALT-07)

- `notifications` 테이블을 큐(outbox)로 쓰는 워커가 5초마다 처리합니다. 실패하면 지수 백오프(30초, 2분, 10분)로 최대 4회 시도하고, 그래도 실패하면 `failed`로 둡니다. 발송 실패 자체는 인앱 알림으로 표시합니다.
- **Slack**: Incoming Webhook URL로 POST합니다. Block Kit으로 심각도 색상, 스케줄러, 환경 라벨, 요약, 대상 상위 10개, 도구 링크(`QA_PUBLIC_URL`)를 넣습니다.
- **이메일**: nodemailer로 SMTP(`QA_SMTP_*`)를 통해 보냅니다. 본문은 텍스트와 HTML을 함께 담고, 수신자는 채널 설정에 둡니다.
- **인앱**: 화면이 30초마다 `GET /alerts/summary`(읽지 않은 수)를 폴링하고, 알림 센터 목록은 `GET /alerts`로 읽습니다.
- 채널마다 테스트 발송 API(`POST /channels/:id/test`)를 둡니다.

## 10. 감사 로그 (FR-AUD)

- 기록 지점: 제어 명령(§7.1 절차), 접속·스케줄러·규칙·채널·사용자 변경, 로그인 성공과 실패, 접속 비밀번호 변경(값은 남기지 않고 "변경됨"만)
- `before_json`과 `after_json`에는 비밀값을 넣지 않습니다. 직렬화 직전에 마스킹 필터를 통과시킵니다.
- 앱 코드에는 `audit_logs`를 수정하는 경로가 없습니다(INSERT와 `pending` 결과 갱신만 존재). 정리는 보존 정책 작업만 합니다.
- `GET /audit-logs`(필터, 페이지네이션), `GET /audit-logs/export.csv`(P1, 스트리밍)

## 11. 배포와 운영

### 11.1 컨테이너

- 멀티 스테이지 빌드: pnpm install → web 빌드(export) → api 빌드 → 운영 의존성만 남긴 `node:24-bookworm-slim` 이미지
- 비루트 사용자로 실행하고, `/data`만 쓰기 가능하게 둡니다(NFR-SEC-05, 파일 권한 600).
- 헬스체크: `GET /healthz`(프로세스), `GET /readyz`(SQLite 접근, 마이그레이션 완료)

### 11.2 환경변수

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `QA_ENCRYPTION_KEYS`, `QA_ENCRYPTION_ACTIVE_KEY` | 예 | 자격증명 암호화 키 |
| `QA_ADMIN_USERNAME`, `QA_ADMIN_PASSWORD` | 최초 기동 시 | 초기 관리자 |
| `QA_PUBLIC_URL` | 예 | Origin 검사, 알림 링크 |
| `QA_DATA_DIR` | | 기본 `/data` |
| `PORT` | | 기본 3000 |
| `QA_TRUST_PROXY` | | 리버스 프록시 뒤일 때 1 |
| `QA_SESSION_IDLE_MIN` | | 기본 30 |
| `QA_AUDIT_RETENTION_DAYS`, `QA_ALERT_RETENTION_DAYS` | | 기본 365, 90 |
| `QA_MONITOR_CONCURRENCY` | | 기본 8 |
| `QA_SMTP_HOST`, `QA_SMTP_PORT`, `QA_SMTP_USER`, `QA_SMTP_PASSWORD`, `QA_SMTP_FROM`, `QA_SMTP_SECURE` | 이메일 사용 시 | |
| `QA_LOG_LEVEL` | | 기본 info |

### 11.3 로깅

- pino JSON 로그에 `requestId`, `userId`, `schedulerId`, `command`, `durationMs`를 넣습니다.
- `password`, `password_enc`, `config_enc`, `authorization`, `cookie` 경로는 마스킹합니다. 드라이버 오류 메시지는 접속 문자열을 지운 뒤 기록합니다(NFR-SEC-03).

## 12. 테스트 전략

| 계층 | 도구 | 대상 | 실행 |
| --- | --- | --- | --- |
| 단위 | Vitest | `@qa/core`(cron 벡터 비교, 트리거 계산, TZ, props), 알림 상태 기계, 암호화, zod 스키마 | 로컬, CI |
| 저장소 통합 | Vitest + Testcontainers | `@qa/store`: 자동 감지, 조회, 명령 | 로컬(최신 버전), CI(매트릭스 전체) |
| Quartz 동작 통합 | Testcontainers + quartz-testbed 2노드 | 제어 결과를 실제 발화 여부로 검증 | CI, 로컬 선택 실행 |
| 차등 테스트 | quartz-testbed HTTP 제어 API | 같은 초기 상태에서 Quartz API와 도구로 각각 명령을 실행하고 결과 행을 비교(FR-CTL-00d) | CI |
| API | Vitest + supertest | 인증, 권한, CSRF, 감사 로그 기록 | 로컬, CI |
| E2E | Playwright | 로그인, 접속 등록, 일시정지/재개, 알림 확인 | CI(P1) |

### 12.1 quartz-testbed

`tools/quartz-testbed`. 환경변수, API 명세, 실행 기록 컬럼은 `tools/quartz-testbed/README.md`에 있습니다.

- Java 17과 Quartz(빌드 인자 `QUARTZ_VERSION`으로 2.3.2 또는 2.5.x 선택)를 쓰는 단독 실행 앱입니다. Maven으로 빌드하며, Dockerfile이 빌드와 JUnit 테스트를 함께 돌립니다.
- JDBC JobStore(`JobStoreTX`) 클러스터 모드입니다. DB 접속, `SCHED_NAME`, 테이블 prefix, instanceId, 체크인 간격을 환경변수로 받습니다. 커넥션 풀은 Quartz 버전마다 기본 제공 풀이 달라 HikariCP를 `ConnectionProvider`로 직접 붙입니다.
- 테스트 잡 세 종류. 모두 시작과 종료를 `TESTBED_EXECUTIONS` 테이블에 남깁니다(노드가 기동할 때 없으면 생성).
  - `RecordingJob`: 실행 기록만 남기고 끝남
  - `NonConcurrentSleepJob`: `@DisallowConcurrentExecution`을 붙이고 `sleepSeconds`초 동안 실행
  - `LongJob`: `durationSeconds`초(기본 600) 실행. `/control/interrupt`로 멈춤
- `GET/POST /control/*` HTTP API: Quartz `Scheduler` 메서드(pause/resume trigger·job·group, `pauseAll`/`resumeAll`, `triggerJob`, `rescheduleJob`, `unscheduleJob`, `deleteJob`, `scheduleJob`, `addJob`, 상태 조회)를 그대로 호출합니다. 차등 테스트의 기준값을 만드는 데 씁니다.
- 스키마 초기화는 Quartz 배포본의 `tables_*.sql`을 씁니다(`tools/quartz-testbed/schema/`에 2.5.2 jar의 파일을 그대로 둠). 헬퍼가 CREATE 문만 골라 prefix와 대소문자를 바꿉니다. 테이블뿐 아니라 제약 조건과 인덱스 이름의 prefix도 바꾸므로 한 스키마에 prefix 여러 개를 둘 수 있습니다. 변형 시나리오로 사용자 지정 prefix, 대문자와 소문자 테이블명, Oracle 23 `BOOLEAN` 스키마(`tables_oracle23.sql`), MySQL `lower_case_table_names=1`(B-28), 한 DB 안의 여러 SCHED_NAME을 둡니다.
  - Quartz는 테이블명을 따옴표 없이 쓰므로 Oracle의 소문자(따옴표) 테이블에는 Quartz 노드를 붙일 수 없습니다. 이 변형은 자동 감지 테스트에만 씁니다.
- `cron-vectors` 서브커맨드로 §6.2의 벡터를 만듭니다. 입력은 (cron, 타임존, 기준 시각 목록), 출력은 조합마다 다음 실행 시각 20개(epoch ms와 해당 타임존 ISO-8601)입니다. 잘못된 표현식은 Quartz 오류 메시지를, 모르는 타임존은 Java가 실제로 쓴 ID(`GMT`)를 함께 남깁니다.

통합 테스트 헬퍼는 `packages/store/test/support/`에 있고 `pnpm test:integration`(Docker 필요)으로 돕니다. 단위 테스트(`pnpm test`)와는 분리돼 있습니다.

| 헬퍼 | 내용 |
| --- | --- |
| `startOracle` | Oracle Free 23(`gvenzl/oracle-free:23-slim-faststart`) 기동, 앱 계정, SYSTEM 접속, 추가 계정 생성 |
| `initQuartzSchema` / `dropQuartzSchema` | Quartz 스키마 생성·삭제(prefix, 대소문자, `oracle`/`oracle23` 변형) |
| `startTestbedNode` / `startOracleQuartzCluster` | 테스트베드 노드 기동, Oracle + 스키마 + N노드 클러스터(기본 2) 기동과 체크인 대기 |
| `TestbedClient` | `/control/*` API 클라이언트 |
| `listExecutions` / `waitForExecutions` / `clearExecutions` | 실행 기록 조회·대기·삭제 |

S2에서 확인한 사항:

- ojdbc 23은 Oracle 23에 접속하면 `setBoolean`을 네이티브 BOOLEAN으로 보냅니다. Quartz 기본 Oracle 스키마의 불리언 컬럼은 `VARCHAR2(1)`이라 잡 저장이 `ORA-12899`로 실패합니다. 테스트베드는 Oracle에서 `oracle.jdbc.sendBooleanAsNativeBoolean=false`를 기본으로 둬 운영(19c 이하, 이전 드라이버)과 같은 `'1'`/`'0'`을 저장합니다. 사내에서 Oracle 23으로 올리면서 드라이버도 23으로 바꾸면 Quartz 자체가 같은 문제를 겪으므로, 자동 감지(§5.5 4단계)는 `BOOLEAN` 컬럼 타입(`tables_oracle23.sql`)도 `native`로 판정해야 합니다.
- Quartz 2.3.2와 2.5.2의 `tables_oracle.sql`은 주석 오타 하나 말고는 같습니다.
- `JobDetail.isConcurrentExectionDisallowed()`는 2.5에서 이름이 바뀌었습니다. 두 버전에서 같이 도는 Java 코드는 `@DisallowConcurrentExecution` 애너테이션을 직접 확인합니다.

### 12.2 환경 메모

- Apple Silicon: Oracle XE 21과 MySQL 5.7 이미지는 amd64 전용이라 로컬에서는 에뮬레이션으로 느리게 돕니다. 로컬 기본값은 Oracle Free 23과 각 DB 최신 버전으로 두고, 전체 매트릭스는 CI(x64 러너)에서 돌립니다. `gvenzl/oracle-free:23-slim-faststart`와 테스트베드 베이스 이미지는 arm64를 제공합니다.
- CI는 GitHub Actions를 가정합니다. DB별로 잡을 나눠 병렬로 실행합니다. 지금은 `integration-oracle` 잡이 Quartz 2.3.2와 2.5.2 매트릭스로 테스트베드 이미지를 빌드하고(`QA_IT_TESTBED_IMAGE`) 통합 테스트를 돌립니다.

### 12.3 구현 전 확인 항목 (스파이크)

| ID | 내용 | 결과물 |
| --- | --- | --- |
| S1 | Quartz 2.3.2 `JobStoreSupport`, `StdJDBCDelegate`, `StdRowLockSemaphore`를 읽고 §7.2와 §7.3의 상태 전이, 잠금, `rescheduleJob` 동작을 확인 | 확인 결과를 TRD에 반영 |
| S2 | quartz-testbed와 Testcontainers 4종 DB 골격. 2노드 클러스터 기동 확인 | `tools/quartz-testbed`, 테스트 헬퍼 |
| S3 | `oracledb` Thin 모드로 Oracle XE 21과 Free 23에 접속하고 BLOB과 NUMBER 매핑 확인 | 어댑터 프로토타입 |
| S4 | `CronExpression` 이식 범위와 Luxon으로 Java Calendar의 DST 처리(존재하지 않는 시각, 중복 시각)를 재현할 수 있는지 확인 | 벡터 50개 통과 프로토타입 |

## 13. PRD 변경 제안

TRD를 쓰면서 Quartz 동작 방식 때문에 PRD를 조정해야 하는 항목입니다. 2026-11-05에 6건 모두 승인되어 PRD v0.3에 반영했습니다.

| # | 대상 | 제안 | 이유 |
| --- | --- | --- | --- |
| 1 | FR-CTL-04 | "도구가 다시 계산한다"를 "재개 후 Quartz 노드가 misfire 정책에 따라 처리한다(도구는 상태만 전이)"로 변경 | 결과는 같고, misfire 처리 방식과 캘린더를 이식하지 않아도 됨(§7.4) |
| 2 | FR-CTL-06/07 | 캘린더가 연결된 트리거는 스케줄 수정 대상에서 제외 | 캘린더는 Java 직렬화 BLOB이라 제외 시간을 계산할 수 없음 |
| 3 | FR-CTL-12 | 고아 `FIRED_TRIGGERS` 정리를 MVP에서 빼고, "오래된 실행 기록 표시"로 대체 | Quartz ClusterManager가 죽은 노드의 실행 기록을 복구(복구 요청 잡 재실행, BLOCKED 해제)하며 정리함. 수동 삭제는 이 복구를 건너뜀 |
| 4 | FR-ALT-04 | 노드 이탈 판정 기준을 "체크인 시각"에서 "활성 노드 수 < 기대 노드 수"로 변경(기대 노드 수는 설정값) | 살아남은 노드가 죽은 노드의 행을 곧바로 삭제하고, AUTO 인스턴스 ID는 재시작마다 바뀜(§9.2) |
| 5 | FR-CTL-00d | 스케줄 수정 시 개별 일시정지 상태를 유지하는 것을 Quartz와의 의도된 차이로 명시 | Quartz `rescheduleJob`은 일시정지를 해제함 |
| 6 | NFR-REL-04 | 다중 인스턴스를 감지하면 "경고"가 아니라 "기동 거부" | SQLite 파일 하나를 두 프로세스가 쓰면 감시와 발송이 중복됨 |
