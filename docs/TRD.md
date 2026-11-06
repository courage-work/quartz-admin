# quartz-admin TRD (기술 요구사항 문서)

| 항목 | 내용 |
| --- | --- |
| 문서 버전 | v0.15 (B-16 대시보드·조회 화면 반영) |
| 작성일 | 2026-11-06 |
| 상태 | 검토 중 |
| 상위 문서 | PRD(`docs/PRD.md`) v0.5 |
| 후속 문서 | 백로그(`docs/BACKLOG.md`) |

이 문서는 PRD의 요구사항을 어떻게 구현할지 정합니다. 요구사항 ID(FR-*, NFR-*)는 PRD를 따릅니다.

### 변경 이력

| 버전 | 날짜 | 내용 |
| --- | --- | --- |
| v0.1 | 2026-11-05 | 초안 |
| v0.2 | 2026-11-05 | 스파이크 S1(B-08): Quartz 2.3.2, 2.5.2 소스와 대조해 §5.4, §7.1~7.6, §9.2를 확정하고 부록 A(상태 전이 테스트 케이스)를 추가 |
| v0.3 | 2026-11-06 | B-04: §1 API 행(nestjs-zod 대신 자체 `ZodPipe`), §2.3 API 공통 규칙 추가, §4.2·§4.3 인증·세션·CSRF 세부 규칙 확정, §11.2 초기 관리자·프록시 규칙 보완 |
| v0.4 | 2026-11-06 | B-37: §1 UI 구성 행에 테마(tweakcn nature), 폰트, `@shadcn/lint`, 디자인 문서(`docs/DESIGN.md`) 추가 |
| v0.5 | 2026-11-06 | B-05: §10 기록 방식(`pending` 흐름, 작업 종류, 마스킹 규칙, 기록하지 않는 요청, 조회 API 형식) 확정, §2.3에 요청 ID와 전역 `CLOCK` 추가 |
| v0.6 | 2026-11-06 | B-06: §2.2 화면 서빙 규칙과 개발 서버 프록시, §4.3 화면 HTML의 CSP(인라인 스크립트 해시), §10 감사 기록 단건 조회 추가 |
| v0.7 | 2026-11-06 | B-07: §11.1 이미지·compose·헬스체크 세부, §11.3 로그 형식과 마스킹 확정 |
| v0.8 | 2026-11-06 | B-10: §6 이식 범위·지원 범위(2.3.2와 2.5.x 차이)·Java Calendar 흉내·벡터 생성 방식 확정, §12.1 `core-vectors` 추가 |
| v0.9 | 2026-11-06 | B-11(S3): §5.2 풀 구현 방식(직접 관리, 연결 중 자리 유지, 끊긴 커넥션 폐기, 강제 시간 제한)과 oracledb 설정, §5.3 Oracle 바인드를 `:p1`로 변경, §5.4 `readTime`, §5.6 오류 분류 추가, §12.3 S3 완료 |
| v0.10 | 2026-11-06 | §12.2: MVP 기능 개발 동안 PR CI 중지(main 머지 후와 수동 실행만) |
| v0.11 | 2026-11-06 | B-12: §5.5 자동 감지 세부 규칙(스키마 해석, prefix 후보 거르기, 대소문자 매칭, Quartz 1.x 제외, 기능 키, 불리언 판정 순서, 권한 점검의 문장별 ROLLBACK, Oracle 23 `ORA-41900`)과 감지 결과 형식 확정 |
| v0.12 | 2026-11-06 | B-13: §5.7 접속·스케줄러 관리 API 추가, §5.6 HTTP 상태 확정, §12.1 손 확인용 테스트베드(`testbed:up`) 추가 |
| v0.13 | 2026-11-06 | B-14: §8.1~8.3 조회 API 응답 형식·검색·정렬·오래된 실행 기록·JobDataMap 판정 확정, LIKE 이스케이프 문자를 `!`로 변경, §3.2 `schedulers.table_schema` 추가 |
| v0.14 | 2026-11-06 | B-15: §8.4 스냅샷 상태 판정·실패 시 보존 규칙·스냅샷 API, §9.1 감시 루프 구현(고정 주기, 겹침 건너뛰기, 첫 회차 지터, 동시 실행, 회차 제한, 변경 이벤트, 확장 지점, 수집 쿼리) 확정 |
| v0.15 | 2026-11-07 | B-16: §8.1 대시보드 목록·스케줄러 상세 응답 형식과 화면 구성, §8.4 대시보드 응답 시간 확인 결과 추가 |

Quartz 클래스와 메서드를 근거로 적을 때는 다음 약칭을 씁니다. `JSS` = `org.quartz.impl.jdbcjobstore.JobStoreSupport`, `Delegate` = `StdJDBCDelegate`(SQL 문은 `StdJDBCConstants`), `QS` = `org.quartz.core.QuartzScheduler`(`StdScheduler`는 이 클래스에 그대로 위임), `QST` = `QuartzSchedulerThread`. 별도 표시가 없으면 2.3.2와 2.5.2의 동작이 같습니다.

---

## 1. 기술 결정 요약

| 영역 | 결정 | 근거 |
| --- | --- | --- |
| 런타임 | Node.js 24 LTS, TypeScript 6.0 (strict) | better-sqlite3 같은 네이티브 모듈의 사전 빌드 지원이 안정적. TypeScript 7은 typescript-eslint 8.x가 지원하지 않아(<6.1) 보류 |
| 모듈 방식 | 전체 ESM (`"type": "module"`, `module: NodeNext`) | NestJS 12가 ESM 전용. 상대 import에는 `.js` 확장자를 붙임 |
| 레포 구조 | pnpm workspace 모노레포 + Turborepo, 버전은 pnpm catalog로 한 곳에서 관리 | UI, API, 공유 타입, Quartz 로직을 패키지로 분리해 단독 테스트 |
| 관리 UI | Next.js 16(App Router) 정적 export(SPA) | 단일 컨테이너, 같은 오리진 |
| UI 구성 | shadcn/ui(Radix + Tailwind CSS v4, radix-vega 스타일), TanStack Query, TanStack Table(가상 스크롤), react-hook-form + zod | 관리 화면에 필요한 표, 폼, 대화상자를 빠르게 구성 |
| 디자인 시스템 | tweakcn `nature` 테마 + 상태 색 토큰, 라이트·다크, Pretendard·D2Coding(번들 포함), `@shadcn/lint`로 토큰·variant 이탈을 lint 오류로 처리. 세부는 `docs/DESIGN.md` | 사내망에서도 폰트가 깨지지 않고, 화면마다 색과 간격이 달라지지 않게 함 |
| API | NestJS 12, REST(`/api/v1`), `@qa/shared`의 zod 스키마를 자체 `ZodPipe`로 검증 | 1인 개발에서 타입을 한 곳에서만 관리. nestjs-zod 5.5는 peer가 NestJS `^10 \|\| ^11`이라 쓰지 않으며, OpenAPI 자동 생성은 nestjs-zod가 NestJS 12를 지원하면 다시 검토 |
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
- 빌드(`pnpm build`)는 웹 결과물(`apps/web/out`)을 `apps/api/public`으로 복사합니다(`apps/api/scripts/copy-web.mjs`, Turbo에서 API 빌드가 웹 빌드 뒤에 실행). 파일이 없으면 API만 제공합니다.
- NestJS는 `/api` 이외의 GET/HEAD 요청을 Nest 라우터보다 먼저 처리합니다(`apps/api/src/web/web-assets.ts`). 찾는 순서는 파일 그대로 → `<경로>.html` → `<경로>/index.html`이고, 없으면 `404.html`을 404로 돌려줍니다. 그래서 `/scheduler?id=12`를 새로고침해도 `scheduler.html`이 뜹니다.
  - 파일 목록은 기동 시 한 번 읽습니다. 목록에 없는 경로(`..` 포함)는 열지 않습니다.
  - HTML은 `Cache-Control: no-cache`, 해시가 붙은 `_next/static/*`은 1년 `immutable`로 응답합니다.
- 개발 중에는 웹 개발 서버(`next dev`, 포트 3001)가 `/api`를 API(`QA_API_URL`, 기본 3000)로 프록시합니다(개발 모드에서만 rewrites 사용). 브라우저 기준으로 같은 오리진이 되도록 API의 `QA_PUBLIC_URL`을 `http://localhost:3001`로 둡니다.

### 2.3 API 공통 규칙

- 요청 본문은 `@qa/shared`의 zod 스키마로 검증합니다(`apps/api/src/common/zod.pipe.ts`). 실패하면 400 `VALIDATION_FAILED`와 필드별 `details`를 돌려주고, 입력값은 응답에 넣지 않습니다.
- 오류 응답 본문은 모두 `ApiErrorBody { code, message, details? }`입니다(`@qa/shared` `errors.ts`). 화면은 `code`로 분기하고 `message`(한국어)를 그대로 보여줍니다. 없는 경로나 깨진 JSON 같은 Nest 기본 예외도 같은 형식으로 바꾸고, 처리하지 못한 예외는 내부 정보 없이 500 `INTERNAL_ERROR`로 응답합니다(`ApiExceptionFilter`).
- 모든 API는 기본적으로 로그인이 필요합니다. 예외 경로에만 `@Public()`, 관리자 전용 경로에는 `@AdminOnly()`를 붙입니다.
- 시각을 다루는 서비스는 `Date.now()` 대신 `CLOCK`을 주입받습니다(전역 `ClockModule`). 테스트에서 만료와 잠금을 시간 이동으로 검증하기 위해서입니다.
- 요청마다 ID를 붙여 `X-Request-Id` 응답 헤더로 돌려줍니다. 프록시가 보낸 `X-Request-Id`는 `[A-Za-z0-9._-]{8,64}` 형식일 때만 이어 쓰고, 아니면 새 UUID를 만듭니다. 감사 로그의 `request_id`와 서버 로그(§11.3)가 이 값을 씁니다.

## 3. 메타데이터 저장소 (SQLite)

### 3.1 운영 설정

- PRAGMA: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`
- 마이그레이션: `drizzle-kit generate`로 SQL을 만들어 레포에 커밋하고, 기동할 때 `migrate()`로 적용합니다(NFR-OPS-04).
- 백업: better-sqlite3 온라인 백업 API(`db.backup()`)를 매일 실행해 `/data/backups/`에 7개까지 보관합니다. 수동 백업 CLI(`node dist/cli backup`)도 제공합니다(NFR-REL-03).
- 단일 인스턴스 보장: 기동 시 전용 `instance_lock` 테이블(행 1개)에 인스턴스 ID, 호스트, pid, 하트비트(10초 주기)를 기록합니다. 최근 30초 안에 갱신된 다른 인스턴스의 하트비트가 있으면 **기동을 거부**합니다(NFR-REL-04, §13 제안 6).
  - 락은 마이그레이션보다 먼저 확보해야 하므로(동시 마이그레이션 방지) drizzle 스키마가 아니라 락 코드가 직접 만듭니다. 확보는 `BEGIN IMMEDIATE` 트랜잭션으로 합니다.
  - 같은 호스트에서 보유 pid가 죽었거나 내 pid와 같으면(컨테이너 재시작) 30초를 기다리지 않고 인수합니다.
  - `main.ts`는 Nest 초기화 전에 기록 없이 락 상태만 먼저 확인해, 거부 사유를 스택 트레이스 없이 한 줄로 출력합니다.
  - 하트비트 갱신에 실패하면(다른 인스턴스가 락을 가져감) 중복 실행을 막기 위해 프로세스를 종료합니다.

### 3.2 스키마

| 테이블 | 주요 컬럼 | 비고 |
| --- | --- | --- |
| `users` | id, username(unique), password_hash, is_admin, is_active, failed_login_count, locked_until, last_login_at, created_at, updated_at | |
| `sessions` | id(토큰의 SHA-256), user_id, ip, user_agent, created_at, last_seen_at, expires_at | 원본 토큰은 쿠키에만 존재 |
| `connections` | id, name, db_type, host, port, database, oracle_service_name, oracle_sid, schema_name, username, password_enc, options_json(SSL 등), env_label, tags_json, read_only(사용자 지정), write_capable(감지 결과), created_by, created_at, updated_at | |
| `schedulers` | id, connection_id(FK, cascade), table_prefix, table_schema(감지한 소유 스키마), table_names_json(실제 테이블명), sched_name, display_name, features_json(선택 컬럼·테이블 존재 여부), bool_format, misfire_threshold_ms(기본 60000), overdue_grace_ms(기본 60000), checkin_multiplier(기본 3), expected_node_count, poll_interval_sec(기본 60), muted_until, detected_at, created_at, updated_at | unique(connection_id, table_prefix, sched_name) |
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
| `settings` | key, value, updated_at | 내부 설정값 |
| `instance_lock` | id(=1), instance_id, host, pid, started_at, heartbeat_at | 단일 인스턴스 락. 마이그레이션 밖에서 생성(§3.1) |

- 컬럼명은 drizzle `casing: 'snake_case'`로 변환하고, 시각은 모두 epoch ms 정수, JSON은 TEXT로 저장합니다.
- 감사 로그의 `connection_id`, `scheduler_id`에는 외래키를 걸지 않습니다. 대상이 삭제돼도 기록이 남아야 하기 때문입니다.
- `alerts`의 "열린 알림은 (rule_id, fingerprint)당 하나"는 부분 고유 인덱스(`WHERE status <> 'resolved'`)로 보장합니다.

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
- 구현: `SecretBox`(`apps/api/src/crypto/secret-box.ts`). 복호화할 때도 인증 태그 길이를 16바이트로 고정해, 잘린 태그로 검증을 약하게 만드는 공격을 막습니다. 실패 원인은 `format`, `unknown-key`, `auth`로 구분합니다.
- AAD에 행 ID가 들어가므로, 새 행은 비밀값 칸을 비운 채 INSERT한 뒤 **같은 트랜잭션에서** 받은 ID로 암호화해 UPDATE합니다.
- 키 교체 절차:
  1. `cli gen-key --id k2`로 새 키를 만듭니다.
  2. `QA_ENCRYPTION_KEYS`에 k1과 k2를 함께 넣고, `QA_ENCRYPTION_ACTIVE_KEY=k2`로 바꿉니다.
  3. 도구를 멈추고 `cli rotate-keys`를 실행합니다. 한 트랜잭션에서 처리하므로 하나라도 복호화하지 못하면 아무것도 바꾸지 않으며, `--dry-run`으로 미리 확인할 수 있습니다.
  4. 도구를 다시 시작하고, 정상 동작을 확인한 뒤 k1을 키 목록에서 뺍니다.
  - `rotate-keys`는 단일 인스턴스 락을 잡으므로, 도구가 실행 중이면 거부됩니다.

### 4.2 인증과 세션 (FR-USR)

- 비밀번호는 argon2id로 해시합니다(memory 19MiB, iterations 2, parallelism 1, OWASP 권장값). 길이는 8~256자입니다. 상한은 아주 긴 입력으로 해시 계산 부하를 일으키는 요청을 막기 위한 것입니다.
- 아이디는 앞뒤 공백을 지우고 소문자로 맞춰 저장·비교합니다. 영문, 숫자, `.`, `_`, `@`, `-`로 된 3~64자입니다.
- 세션 쿠키 `qa_sid`는 32바이트 난수(base64url)이며 `HttpOnly; Secure; SameSite=Strict; Path=/`로 설정합니다. 만료 시각을 넣지 않은 세션 쿠키라 브라우저를 닫으면 사라집니다. `QA_PUBLIC_URL`이 `http://`일 때(로컬 개발)만 `Secure`를 끕니다.
- DB `sessions.id`에는 토큰의 SHA-256만 저장합니다. 로그인하면 요청에 붙어 온 이전 세션을 지우고 새로 발급합니다.
- 유휴 만료는 30분(`QA_SESSION_IDLE_MIN`), 절대 만료는 12시간입니다. `expires_at`에는 둘 중 이른 시각을 넣고 인증된 요청마다 다시 계산합니다. 만료된 세션은 조회 시점에 바로 무효가 되고, 남은 행은 일일 보존 정리(§3.3)가 지웁니다.
- 로그인 실패가 5회 이어지면 계정을 15분 동안 잠그고 실패 횟수를 0으로 되돌립니다. 성공하면 실패 횟수를 0으로 되돌립니다. 잠긴 동안의 시도는 비밀번호를 확인하지 않고 423 `ACCOUNT_LOCKED`로 거부하며 횟수에 넣지 않습니다.
- 없는 아이디, 비활성 계정, 틀린 비밀번호는 모두 401 `INVALID_CREDENTIALS`로 같게 응답합니다. 없는 아이디도 더미 해시와 비교해 응답 시간을 맞춥니다.
- 로그인 API는 IP당 분당 10회로 제한합니다(429 `RATE_LIMITED`, `Retry-After`). 단일 프로세스이므로 메모리의 고정 창 카운터를 씁니다. 재시작하면 초기화되지만 계정 잠금은 DB에 남습니다.
- 세션 무효화: 비활성화하면 그 사용자의 세션을 모두, 관리자가 비밀번호를 초기화하면 모두(잠금도 해제), 본인이 비밀번호를 바꾸면 현재 세션만 남기고 지웁니다. 비활성 사용자의 세션은 남아 있더라도 인증 시 거부합니다.
- 본인 계정은 비활성화할 수 없습니다(409 `OPERATION_NOT_ALLOWED`). 호출자는 항상 활성 관리자이므로 활성 관리자가 0명이 되는 일도 없습니다.
- 초기 관리자: `users` 테이블이 비어 있을 때만 `QA_ADMIN_USERNAME`과 `QA_ADMIN_PASSWORD`로 관리자를 만듭니다. 계정이 있으면 이 값을 쓰지 않습니다(비밀번호를 바꿔 다시 기동해도 기존 계정은 그대로).
- 인증 계층은 `AuthProvider` 인터페이스(`authenticate(credentials) → UserIdentity`) 뒤에 둡니다. 후속 OIDC 지원을 위한 구조입니다(FR-USR-06). 지금 구현은 `LocalAuthProvider`이고, 세션 발급과 권한 확인은 공급자와 무관하게 `SessionsService`와 전역 가드가 맡습니다.
- API(관리자 전용은 *로 표시)

  | 메서드 | 경로 | 설명 |
  | --- | --- | --- |
  | POST | `/auth/login` | 로그인. 본인 정보(`MeResponse`)와 세션 쿠키 |
  | POST | `/auth/logout` | 로그아웃. 세션이 없어도 쿠키를 지우고 204 |
  | GET | `/auth/me` | 본인 정보. 화면의 로그인 확인용(§2.2) |
  | PUT | `/auth/password` | 본인 비밀번호 변경(`currentPassword`, `newPassword`) |
  | GET | `/users`* | 사용자 목록(비밀번호 해시 제외, 잠금 해제 시각 포함) |
  | POST | `/users`* | 사용자 추가(`username`, `password`, `isAdmin`) |
  | PATCH | `/users/:id`* | 활성/비활성 전환(`isActive`) |
  | POST | `/users/:id/reset-password`* | 비밀번호 초기화 |

### 4.3 웹 보안 (NFR-SEC-04)

- CSRF: 상태를 바꾸는 요청(GET/HEAD/OPTIONS 이외)은 `Origin` 헤더가 `QA_PUBLIC_URL`의 origin과 같고 `X-QA-Request: 1` 헤더가 있어야 받습니다. `Origin`이 없어도 거부합니다. 로그인 요청에도 적용해 로그인 CSRF를 막습니다. 실패하면 403 `CSRF_REJECTED`입니다. `SameSite=Strict`와 함께 이중으로 방어합니다. 전역 가드 순서는 CSRF 검사 → 인증·권한입니다.
- helmet 기본값으로 CSP(`default-src 'self'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer` 등을 설정하고 `X-Powered-By`를 뺍니다(`apps/api/src/app.setup.ts`). Next.js 정적 export는 HTML마다 인라인 스크립트(RSC 페이로드 등)를 넣으므로, 화면 HTML은 helmet 기본값에서 `script-src`에 **그 파일의 인라인 스크립트 SHA-256 해시만** 더한 CSP로 응답합니다. 해시는 기동 시 HTML을 읽어 미리 계산하고, `'unsafe-inline'`은 쓰지 않습니다. `QA_PUBLIC_URL`이 http면 `upgrade-insecure-requests`를 뺍니다(사내망 http 주소에서 정적 파일 요청이 https로 바뀌어 깨지는 것 방지). API 응답의 CSP는 helmet 기본값 그대로입니다.
- TLS는 앞단 리버스 프록시에서 종단하는 것을 기본으로 합니다. 이때 `QA_TRUST_PROXY=1`로 실제 클라이언트 IP를 감사 로그와 로그인 속도 제한에 씁니다. 프록시는 한 단계만 신뢰합니다(Express `trust proxy` = 1). 클라이언트가 보낸 `X-Forwarded-For`로 IP를 속일 수 없게 하기 위해서입니다.

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

구현(`packages/store/src/pool-manager.ts`):

- 드라이버 풀 대신 `TargetPoolManager`가 직접 관리합니다. 드라이버마다 대기 제한과 유휴 종료 방식이 달라(mysql2 풀에는 대기 제한이 없음) 4종에서 같은 규칙을 맞추기 위해서입니다. 어댑터(`DriverAdapter`)는 커넥션을 하나씩 열기만 합니다.
- 접속마다 풀이 따로 있어서, 한 대상이 응답하지 않으면 그 접속의 요청만 기다리거나 실패합니다. 다른 접속의 요청은 영향을 받지 않습니다(NFR-REL-01).
- 접속 정보가 바뀌었는지는 접속 정보 전체(비밀번호 포함)의 SHA-256으로 판단합니다. 접속을 수정·삭제하면 `invalidate(id)`로 풀을 버립니다. 사용 중인 커넥션은 돌려받을 때 닫습니다.
- 연결 중인 커넥션도 개수에 넣습니다. 연결 제한을 넘기면 호출자에게는 바로 `TARGET_TIMEOUT`을 주지만, 드라이버의 연결 시도가 끝날 때까지 자리를 비우지 않습니다. 응답 없는 대상에 소켓이 계속 쌓이지 않게 하려는 것입니다.
- `TARGET_UNREACHABLE`·`TARGET_TIMEOUT`으로 끝난 커넥션은 끊긴 것으로 보고 풀에 돌려놓지 않습니다. 커밋하지 않은 트랜잭션이 남은 커넥션은 롤백한 뒤 돌려놓습니다.
- 유휴 커넥션을 빌려줄 때 따로 확인(ping)하지 않습니다. 대상 DB가 재시작돼 끊긴 커넥션이면 그 요청이 `TARGET_UNREACHABLE`로 한 번 실패하고, 커넥션은 버려지며 다음 요청이 새로 연결합니다.

드라이버별 설정:

- **oracledb**: Thin 모드. 접속은 Easy Connect(`host:port/service`), SID는 접속 기술자로 만듭니다. `connectTimeout`·`transportConnectTimeout`은 연결 제한(초), `callTimeout`은 조회 제한, `expireTime=1`(분)로 끊긴 연결을 감지합니다. BLOB은 Buffer로, 행은 객체 형식으로 받되 전역 `oracledb.fetchAsBuffer`·`outFormat`은 바꾸지 않고 쿼리마다 `fetchTypeHandler`·`outFormat`을 넘깁니다(같은 프로세스의 다른 oracledb 사용처에 영향을 주지 않기 위해). NUMBER는 JS number로 받습니다(epoch ms는 2^53 미만).
  - S3에서 확인: Thin 모드의 `callTimeout`은 시간이 지나면 서버에 중단을 요청하고 그 응답을 기다립니다. 서버가 PL/SQL을 끝까지 실행하거나 네트워크가 멈추면 호출이 돌아오지 않습니다. 그래서 어댑터가 제한 + 1초가 지나면 드라이버 응답을 기다리지 않고 `TARGET_TIMEOUT`으로 끝내고, 그 커넥션은 버립니다.
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
| 바인드 | `:p1` | `$1` | `?` |
| 식별자 | `"QRTZ_TRIGGERS"` | `"qrtz_triggers"` (감지한 실제 대소문자) | `` `QRTZ_TRIGGERS` `` |
| 페이지네이션 | `OFFSET :n ROWS FETCH NEXT :m ROWS ONLY` | `LIMIT $m OFFSET $n` | `LIMIT ? OFFSET ?` |
| 잠금 대기 제한 | `FOR UPDATE WAIT 5`(락 행과 대상 행 모두) | `SET LOCAL lock_timeout = '5s'` | `SET SESSION innodb_lock_wait_timeout = 5` (트랜잭션 후 원복) |
| 격리 수준 | READ COMMITTED (기본값) | READ COMMITTED (기본값) | `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` |
| 현재 시각(ms) | `(CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE) - DATE '1970-01-01') * 86400000 + TO_NUMBER(TO_CHAR(SYSTIMESTAMP,'FF3'))` | `(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint` | `ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000)` |
| 카탈로그 | `ALL_TABLES`, `ALL_TAB_COLUMNS` (OWNER) | `information_schema` (table_schema) | `information_schema` (`DATABASE()`) |

Oracle에서는 DML이 행 잠금을 무기한 기다립니다. 그래서 대상 트리거 행도 `SELECT … FOR UPDATE WAIT 5`로 먼저 잠근 뒤 UPDATE합니다. 대기 초과는 Oracle 23에서 `ORA-00054`, 이전 버전에서 `ORA-30006`이며 둘 다 `LOCK_TIMEOUT`입니다.

- Oracle 바인드 이름이 `:1`이 아니라 `:p1`인 이유: oracledb는 배열 바인드를 이름의 숫자가 아니라 SQL에 나온 순서대로 붙입니다. `OFFSET :2 ROWS FETCH NEXT :1 ROWS ONLY`에 `[limit, offset]`을 넘기면 둘이 뒤바뀝니다(S3에서 확인). 어댑터가 배열을 `{ p1, p2, … }` 이름 바인드로 바꿔 넘기므로 `param(n)`의 번호가 그대로 자리를 가리킵니다.
- `TableSet`(`createTableSet`)은 감지 결과(`table_names_json`)의 실제 이름에 스키마를 붙이고 따옴표로 감싼 식별자(`"QUARTZ"."QRTZ_TRIGGERS"`)를 돌려줍니다. 필수 테이블이 빠졌거나 따옴표를 깨뜨리는 이름은 받지 않습니다.

### 5.4 Quartz 테이블 접근 규칙

- 시각 컬럼(NEXT_FIRE_TIME 등)은 epoch ms입니다. 값이 없을 때 Quartz가 저장하는 값은 경로마다 다릅니다. `NEXT_FIRE_TIME`은 INSERT(`Delegate.insertTrigger`)에서는 SQL `NULL`, UPDATE(`Delegate.updateTrigger`)에서는 `-1`이고, `PREV_FIRE_TIME`은 항상 `-1`, `END_TIME`은 `0`입니다. Quartz는 읽을 때 `> 0`인 값만 유효로 봅니다(`Delegate.selectTriggerStatus`). 도구도 `NULL`과 `0` 이하를 모두 `null`로 바꿉니다(`readTime`). 이 규칙은 시각 컬럼에만 씁니다. `REPEAT_COUNT`의 -1(무한 반복)이나 `TIMES_TRIGGERED`의 0처럼 의미 있는 값을 지우지 않도록, 정수 컬럼은 `readLong`(SQL `NULL`만 `null`)으로 읽습니다.
- 불리언 컬럼은 읽을 때만 정규화합니다. MVP의 쓰기 작업은 불리언 컬럼을 건드리지 않습니다. 새로 넣는 행은 `TRIGGERS`, `SIMPLE_TRIGGERS`, `PAUSED_TRIGGER_GRPS`, `LOCKS`뿐이고, 이 테이블들에는 불리언 컬럼이 없습니다.
- JOB_DATA(BLOB)는 읽기만 합니다. 즉시 실행 트리거의 JOB_DATA는 `NULL`로 넣습니다. Quartz도 맵이 비어 있으면 `NULL`을 넣습니다(`Delegate.insertTrigger`의 `getJobDataMap().size() > 0` 검사).
- Oracle에서는 빈 문자열이 NULL이 되므로, DESCRIPTION 비교는 `IS NULL`과 함께 처리합니다.

### 5.5 자동 감지 (FR-CON-03, FR-CON-04)

구현은 `packages/store/src/detect/`(`detectQuartz`)입니다. 조회와 결과 0행 쓰기만 하고 ROLLBACK하므로 대상 행을 바꾸거나 행 잠금을 잡지 않습니다.

0. **스키마**: 접속의 `schema_name`이 있으면 그 스키마, 없으면 접속 계정의 현재 스키마(Oracle `SYS_CONTEXT('USERENV','CURRENT_SCHEMA')`)를 봅니다. Oracle에서 입력한 이름 그대로는 테이블이 없고 대문자로 바꾸면 있을 수 있으므로(따옴표 없이 만든 계정은 대문자), 입력 그대로 찾아 없으면 대문자로 봅니다. 카탈로그(`ALL_TABLES`)에는 계정이 권한을 가진 테이블만 보이므로, 다른 스키마의 Quartz 테이블도 권한만 있으면 감지합니다.
1. **테이블 탐색**: 카탈로그에서 스키마의 테이블 목록을 읽습니다. 이름을 대문자로 바꿨을 때 `TRIGGERS`로 끝나는 테이블마다 그 앞부분을 prefix 후보로 뽑습니다(prefix는 실제 대소문자 그대로, 빈 prefix도 허용). `QRTZ_SIMPLE_TRIGGERS`에서 나온 `QRTZ_SIMPLE_` 같은 가짜 후보를 버리려고 `<prefix>JOB_DETAILS`도 있는 후보만 남깁니다.
2. **필수 세트 확인**: prefix마다 아래 테이블을 찾아 실제 이름을 `table_names_json`에 기록합니다. 먼저 `TRIGGERS` 테이블과 같은 대소문자(전부 대문자 또는 전부 소문자)로 찾고, 없으면 대소문자를 무시해 하나뿐인 이름을 씁니다. 그래서 같은 스키마에 `QRTZ_` 세트와 따옴표 소문자 `qrtz_` 세트가 함께 있어도 섞이지 않습니다. 필수 테이블이 빠진 prefix는 `unusable`(`MISSING_TABLES`)로 빠진 테이블과 함께 돌려줍니다.
   - 필수: `JOB_DETAILS`, `TRIGGERS`, `SIMPLE_TRIGGERS`, `CRON_TRIGGERS`, `BLOB_TRIGGERS`, `CALENDARS`, `PAUSED_TRIGGER_GRPS`, `FIRED_TRIGGERS`, `SCHEDULER_STATE`, `LOCKS`
   - 선택: `SIMPROP_TRIGGERS`
   - `JOB_DETAILS`, `TRIGGERS`, `SCHEDULER_STATE`, `LOCKS`에 `SCHED_NAME` 컬럼이 없으면 Quartz 1.x 스키마이므로 지원하지 않고 `unusable`(`NO_SCHED_NAME`)로 돌려줍니다(NFR-COMP-01은 2.x).
3. **스키마 기능 감지**: 버전 차이가 나는 테이블과 컬럼의 존재 여부를 `features_json`에 기록합니다. 쿼리 빌더는 이 값에 따라 컬럼을 넣거나 뺍니다.

   | 키 | 확인 대상 |
   | --- | --- |
   | `simpropTriggers` | `SIMPROP_TRIGGERS` 테이블 |
   | `triggerPriority` | `TRIGGERS.PRIORITY` |
   | `firedPriority` | `FIRED_TRIGGERS.PRIORITY` |
   | `firedSchedTime` | `FIRED_TRIGGERS.SCHED_TIME` |
   | `jobNonconcurrent` | `JOB_DETAILS.IS_NONCONCURRENT` |
   | `jobUpdateData` | `JOB_DETAILS.IS_UPDATE_DATA` |
   | `cronTimeZone` | `CRON_TRIGGERS.TIME_ZONE_ID` |
4. **불리언 형식 감지**: `JOB_DETAILS.IS_DURABLE`의 컬럼 타입이 BOOLEAN(Oracle 23 `BOOLEAN`, PostgreSQL `bool`)이면 `native`로 봅니다. 문자·숫자 타입이면 `JOB_DETAILS`의 불리언 컬럼 4개(`IS_DURABLE`, `IS_NONCONCURRENT`, `IS_UPDATE_DATA`, `REQUESTS_RECOVERY`)의 DISTINCT 값으로 `10`/`YN`/`TF` 중 하나를 판정합니다(대소문자와 CHAR 공백 무시, `TRUE`/`FALSE`는 `TF`).
   - 값이 하나도 없으면(잡이 없음) `10`으로 둡니다. Quartz는 `setBoolean`으로 저장하므로 문자 컬럼에는 `'1'`/`'0'`이 들어갑니다. 판정 근거는 `boolFormatSource`(`column-type`/`values`/`default`)로 함께 돌려줍니다.
   - 형식이 섞여 있으면 가장 많이 보이는 형식을 고르고 `BOOL_FORMAT_MIXED`, 알아볼 수 없는 값이 있으면 `BOOL_FORMAT_UNKNOWN_VALUE` 경고를 붙입니다.
5. **SCHED_NAME 목록**: `TRIGGERS`, `JOB_DETAILS`, `SCHEDULER_STATE`, `LOCKS`에서 DISTINCT `SCHED_NAME`을 모아 후보로 제시합니다. 각 후보에 잡 수, 트리거 수, `SCHEDULER_STATE` 행 수, 활성 노드 수(§9.2 정의, 배수 기본 3, 기준은 감지 시점의 DB 현재 시각)를 붙입니다. 잠금 행만 있는 SCHED_NAME(아직 잡을 등록하지 않은 스케줄러)도 후보입니다.
6. **쓰기 권한 점검**: 트랜잭션 안에서 결과 행이 0개인 문장(`SELECT … WHERE 1 = 0`, `UPDATE … SET SCHED_NAME = SCHED_NAME WHERE 1 = 0`, `INSERT INTO t SELECT * FROM t WHERE 1 = 0`, `DELETE … WHERE 1 = 0`)을 실행한 뒤 ROLLBACK합니다. 권한 검사는 실행 단계에서 일어나므로 행을 건드리거나 행 잠금을 잡지 않고도 권한 유무를 판정할 수 있습니다. 하나라도 실패하면 `write_capable=false`로 두고 빠진 권한을 `missingPrivileges`로 돌려줍니다.
   - 실패한 문장마다 바로 ROLLBACK합니다. Oracle은 실패한 문장만 되돌리지만 PostgreSQL은 트랜잭션 전체가 중단돼 다음 문장이 실패하기 때문입니다.
   - 권한 부족은 `TARGET_ERROR`로 오는 오류만 셉니다. 연결이 끊기거나 시간이 넘으면(`TARGET_UNREACHABLE`·`TARGET_TIMEOUT`) 판정할 수 없으므로 감지 전체를 실패시킵니다. Oracle 23은 권한 부족을 `ORA-41900`(없는 권한을 알려줌)으로, 이전 버전은 `ORA-01031`로 알립니다.
   - Oracle DML은 0행이라도 테이블에 RX 모드 TM 잠금을 잡습니다. 행 잠금이 아니라서 Quartz의 DML과 충돌하지 않고, ROLLBACK하면 바로 풀립니다. 다른 세션이 행을 잠그고 있어도 감지는 기다리지 않습니다(통합 테스트로 확인).

   | 테이블 | 필요 권한 |
   | --- | --- |
   | TRIGGERS, SIMPLE_TRIGGERS | SELECT, INSERT, UPDATE, DELETE |
   | CRON_TRIGGERS | SELECT, UPDATE, DELETE |
   | SIMPROP_TRIGGERS, BLOB_TRIGGERS, JOB_DETAILS | SELECT, DELETE |
   | PAUSED_TRIGGER_GRPS | SELECT, INSERT, DELETE |
   | LOCKS | SELECT, INSERT, UPDATE |
   | FIRED_TRIGGERS, SCHEDULER_STATE, CALENDARS | SELECT |
7. **기대 노드 수 초기값**: 감지 시점의 활성 노드 수를 `expected_node_count` 초기값으로 씁니다(§9.2). 클러스터가 내려가 있으면 0이 되며, 이때는 `NODE_MISSING` 대신 `CLUSTER_DOWN`이 잡힙니다. 등록 화면(B-13)에서 바꿀 수 있습니다.

감지 결과(`QuartzDetection`)는 스키마, DB 현재 시각, 쓸 수 있는 테이블 세트 목록(`tableSets`: prefix, 실제 테이블 이름, 기능, 불리언 형식, 쓰기 가능 여부와 빠진 권한, SCHED_NAME 후보, 경고), 쓸 수 없는 prefix 목록(`unusable`)입니다. 화면은 테이블 세트 × SCHED_NAME을 스케줄러 후보로 보여주고, 운영자가 고른 것을 `schedulers` 행으로 저장합니다(B-13). `BOOL_FORMATS`는 `@qa/store`가 정의하고 메타 저장소 스키마가 가져다 씁니다.

### 5.6 대상 DB 오류 분류

드라이버 오류는 어댑터가 `TargetError`로 바꿉니다. 코드는 `@qa/shared`의 `TARGET_ERROR_CODES`이고 API 오류 코드에도 포함됩니다. 화면 문구는 코드마다 고정된 한국어이며, 드라이버 원문은 쓰지 않습니다.

| 코드 | 뜻 | Oracle 예 | 재시도 | HTTP |
| --- | --- | --- | --- | --- |
| `TARGET_UNREACHABLE` | 호스트·포트·서비스에 닿지 못함, 커넥션 끊김 | `NJS-503`, `NJS-511`, `NJS-518`, `NJS-500`, `ORA-12514`, `ECONNREFUSED` | 가능 | 502 |
| `TARGET_AUTH_FAILED` | 인증 실패, 계정 잠김·만료, `CREATE SESSION` 없음 | `ORA-01017`, `ORA-28000`, `ORA-28001`, `ORA-01045`, `NJS-116` | 불가 | 502 |
| `TARGET_TIMEOUT` | 연결 또는 쿼리 실행 제한 초과 | `NJS-510`, `NJS-123`, `ORA-01013`, 어댑터 강제 제한(§5.2) | 가능 | 504 |
| `TARGET_BUSY` | 커넥션 대기 제한 초과(§5.2) | - | 가능 | 503 |
| `LOCK_TIMEOUT` | 행 잠금 대기 초과 | `ORA-00054`, `ORA-30006` | 가능 | 409 |
| `TARGET_ERROR` | 그 밖의 오류. 교착 롤백(`ORA-00060`)은 재시도 가능 | `ORA-00942` 등 | 경우에 따라 | 502 |

- `TargetError`에는 원래 드라이버 오류를 `cause`로 붙이지 않습니다. 로거가 `cause`를 그대로 직렬화하면 접속 문자열이 로그에 남기 때문입니다. 대신 `driverCode`(`ORA-01017` 같은 코드)와 `detail`(접속 정보를 지운 원문, 500자 이내)을 남깁니다. `detail`은 서버 로그용이고 API 응답에는 넣지 않습니다.
- 접속 정보 제거(`redactConnectionInfo`): 그 접속의 호스트, 계정, 비밀번호, 서비스·SID·DB 이름을 값으로 찾아 지우고, 드라이버 메시지 형식(`host X port N`, `(HOST=…)`, `CONNECTION_ID=…`, IP 주소, `ENOTFOUND <host>`, `user "<name>"`)도 지웁니다. 포트는 `:`·공백·`=` 뒤에 올 때만 지워 `ORA-01521` 같은 오류 번호는 그대로 둡니다.
- API는 `TargetError`를 위 상태 코드와 고정 문구로 응답합니다(`ApiExceptionFilter`, `apps/api/src/targets/target-api-error.ts`). 감사 기록의 `error_code`에도 같은 코드가 남습니다. 접속 정보를 지운 원문(`driverCode`, `detail`)은 `TargetsService`가 서버 로그(warn)에만 남깁니다.

### 5.7 접속·스케줄러 관리 API (FR-CON)

로그인한 사용자는 모두 쓸 수 있습니다(PRD 권한 모델). 상태를 바꾸는 요청은 모두 감사 로그에 남기고(`connection.*`, `scheduler.*`), 비밀번호는 요청으로만 받아 응답·감사 기록·로그 어디에도 넣지 않습니다(FR-CON-06). 요청 스키마와 응답 타입은 `@qa/shared`의 `connections.ts`입니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/connections` | 접속 목록. 등록한 스케줄러 수 포함 |
| POST | `/connections/test` | 저장 전 연결 테스트(FR-CON-02). 실패도 200으로 `{ ok: false, code, message }`를 돌려준다 |
| GET | `/connections/:id` | 접속 하나 |
| POST | `/connections` | 접속 등록(FR-CON-01) |
| PUT | `/connections/:id` | 접속 수정(FR-CON-05). 전체 값을 보내고, `password`를 비우면 기존 값을 쓴다 |
| GET | `/connections/:id/delete-impact` | 삭제 영향(스케줄러, 알림 규칙 수, 열린 알림 수) |
| DELETE | `/connections/:id` | 접속 삭제. 하위 스케줄러·알림 규칙·알림·스냅샷은 외래키 cascade로 함께 지워진다 |
| POST | `/connections/:id/detect` | 감지·재감지(FR-CON-03, 05). 후보 목록과 등록 여부를 돌려준다 |
| GET | `/connections/:id/schedulers` | 이 접속에 등록한 스케줄러 |
| POST | `/connections/:id/schedulers` | 감지한 후보를 스케줄러로 등록(`selections: [{ prefix, schedName, displayName? }]`) |
| GET | `/schedulers/:id` | 스케줄러 하나(설정과 감지 정보). 조회 화면용 필드는 B-14·B-16에서 늘린다 |
| GET | `/schedulers/:id/snapshot` | 감시 루프의 마지막 스냅샷(§8.4). 대상 DB를 조회하지 않는다. 아직 감시하지 않았으면 `snapshot: null` |
| PUT | `/schedulers/:id/settings` | 감시 설정(FR-CON-07) |
| GET | `/schedulers/:id/delete-impact` | 등록 해제 영향 |
| DELETE | `/schedulers/:id` | 등록 해제. 대상 DB의 Quartz 데이터는 건드리지 않는다 |

- **입력 검증**: 지금은 `SUPPORTED_DB_KINDS`(Oracle)만 받습니다. Oracle은 서비스 이름과 SID 중 정확히 하나, 다른 DB는 DB 이름이 필요합니다. 호스트·서비스 이름·SID는 접속 기술자를 깨뜨리는 문자(괄호, 등호, 공백)를 받지 않습니다. 환경 라벨은 소문자로 맞추고(`prod`, `stage`, `dev`), 태그는 10개·30자까지이며 중복을 없앱니다. 접속 이름은 고유합니다(409 `CONNECTION_NAME_TAKEN`).
- **비밀번호 저장**: §4.1대로 빈 값으로 INSERT한 뒤 같은 트랜잭션에서 행 ID를 AAD로 암호화해 UPDATE합니다.
- **연결 테스트**: 저장하지 않은 값으로 일회용 풀(`test:<uuid>`)을 만들어 감지까지 실행하고 풀을 바로 닫습니다. 결과는 스키마, 테이블 세트 수, 후보 수, 쓰기 가능 여부입니다. 수정 화면에서 비밀번호를 비우고 `connectionId`를 주면 저장된 비밀번호로 시험합니다.
- **수정과 풀**: 연결에 쓰는 값(DB 종류, 호스트, 포트, DB·서비스·SID, 스키마, 계정, 비밀번호)이 바뀌면 그 접속의 풀을 버리고(`TargetPoolManager.invalidate`) `write_capable`을 비웁니다. 이름·환경·태그·읽기 전용만 바꾸면 그대로 둡니다.
- **감지와 재감지**: 결과를 그대로 돌려주면서, 이미 등록된 스케줄러(같은 prefix와 SCHED_NAME)는 테이블 이름·기능·불리언 형식·`detected_at`을 새 결과로 갱신합니다(`refreshedSchedulerIds`). 등록돼 있지만 찾지 못한 스케줄러는 `missingSchedulerIds`로 알리고 지우지 않습니다. 접속의 `write_capable`은 테이블 세트가 하나 이상이고 모두 쓰기 가능하면 true, 세트가 없으면 null입니다.
- **등록**: 화면이 보낸 테이블 이름을 믿지 않고 서버가 다시 감지해 카탈로그로 확인한 이름만 저장합니다(NFR-SEC-02). 고른 후보가 결과에 없으면 409 `SCHEDULER_NOT_DETECTED`, 이미 등록됐으면 409 `SCHEDULER_ALREADY_REGISTERED`이며 한 요청의 등록은 모두 성공하거나 모두 실패합니다. 감지한 스키마(`table_schema`)도 함께 저장해 조회 SQL이 `"스키마"."테이블"`로 씁니다(재감지 때도 갱신). 기대 노드 수는 감지한 활성 노드 수, 표시 이름 기본값은 SCHED_NAME(같은 이름이 여러 prefix에 있으면 `이름 (prefix)`)입니다. 기본 알림 규칙 생성(§9.2)은 B-24에서 붙입니다.
- **감시 설정 범위**: misfire 임계값과 연체 유예 1초~1시간(유예 ≥ 임계값, §9.2), 체크인 배수 2~20, 기대 노드 수 0~100, 감시 주기 15~3600초.
- **감사 기록**: `connection.create/update/delete`는 접속 값(비밀번호 제외)을 before/after로, 수정은 `passwordChanged`를 남깁니다. `connection.detect`는 세트별 prefix·쓰기 가능 여부·후보 이름과 갱신·누락 ID를, `scheduler.register`는 등록한 스케줄러 목록을, `scheduler.update`는 설정 전후를 남깁니다. 대상 DB 오류로 실패하면 `error_code`에 `TARGET_*` 코드가 남습니다.
- **화면**(`apps/web`): 목록 `/connections`, 추가 `/connections/new`, 상세 `/connection?id=`(정보, 등록한 스케줄러, 감지·등록 패널), 수정 `/connection/edit?id=`. 새 접속을 저장하면 상세 화면으로 가서 바로 감지합니다(`&detect=1`). 삭제와 등록 해제는 영향 범위를 보여 준 뒤 확인합니다.

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

- Quartz는 Apache License 2.0입니다. 이식한 파일에는 원본 저작권 고지와 라이선스를 남기고, 루트 `NOTICE`에 적습니다.
- 공개 API(`@qa/core`): `validateCron`(검증과 한국어 오류), `cronSchedule(expr, javaTimeZoneId)`(`next`, `nextTimes`), `CronTriggerCalc`, `SimpleTriggerCalc`, `resolveJavaTimeZone`, `parseJavaProperties`(`Bytes`)
- `getTimeAfter`는 원본 알고리즘을 줄 단위로 옮기고, `java.util.GregorianCalendar`(lenient)의 필드 설정·정규화를 `cron/java-calendar.ts`로 흉내 냅니다. 벽시계 시각 → 순간 변환은 JDK `ZoneInfo.getOffsetsByWall`과 같아서, DST 시작일의 없는 시각은 앞으로 밀리고(그날은 건너뜀) 종료일의 겹치는 시각은 표준시(뒤쪽 순간)로 봅니다. 오프셋은 Luxon(ICU 데이터)으로 구합니다.
- `tz`는 `TimeZone.getTimeZone` 규칙을 따릅니다. JDK가 아는 ID 목록(`tz/java-zone-ids.ts`, 벡터 생성 시 함께 만듦)에 있으면 그 ID, 3글자 축약 ID는 `ZoneId.SHORT_IDS`(`EST`·`MST`·`HST`는 고정 오프셋), `GMT±h[h][[:]mm]`은 고정 오프셋, 나머지는 GMT입니다. GMT로 바뀌었는지(`fallbackToGmt`)를 함께 알려 화면이 경고할 수 있게 합니다.

**지원 범위** (PRD R2). 도구는 "Quartz 2.3.2와 2.5.x가 모두 받아들이고 같은 시각을 계산하는 표현식"만 받습니다. 2.5.x는 `L`·`W` 계산을 다시 썼고 몇 가지 검증을 더했기 때문입니다(벡터로 확인한 차이).

| 형태 | 2.3.2 | 2.5.x | 도구 |
| --- | --- | --- | --- |
| `L`·`LW`를 다른 날짜와 함께(`L,15`) | 거부 | 허용 | 거부 |
| `W`를 다른 날짜와 함께(`1W,15`) | 허용 | 허용(결과 다름) | 거부(지원 안 함) |
| 29일 이후의 `W`(`29W`~`31W`) | 허용 | 허용(그 날이 없는 달에서 결과 다름) | 거부(지원 안 함) |
| 필드 8개 이상 | 나머지 무시 | 거부 | 거부 |
| 초·분·시 필드의 `L` | 계산 중 예외 | 거부 | 거부 |

이 밖에 Quartz 파서가 너그럽게 받는 형태도 거부합니다: 이름에 증가값(`JAN-MAR/2`, 2.3.2는 증가값을 무시), 증가값 0, 1970년 이전·2999년 이후 연도, `?a`처럼 뒤에 붙은 문자. 오류는 `{ code: SYNTAX | RANGE | UNSUPPORTED | QUARTZ, field, message }`이고 `message`는 한국어입니다.
- misfire 처리 방식별 다음 실행 시각 계산(`updateAfterMisfire`)은 **이식하지 않습니다**. 재개할 때 발생하는 misfire는 Quartz 노드의 MisfireHandler에 맡깁니다(§7.4).

### 6.2 교차 검증

- `tools/quartz-testbed`의 `core-vectors` 명령이 실제 Quartz와 JDK로 벡터를 만듭니다. `pnpm --filter @qa/core vectors`(`scripts/generate-vectors.mjs`)가 케이스(`scripts/vector-cases.mjs`)를 Quartz 2.3.2, 2.5.2 이미지에 넣어 `test/vectors/quartz.json`을 만들고, 두 버전 결과가 다르면 항목에 `v252`로 남깁니다.
- cron: 표현식 60개 × 타임존 4개(UTC, Asia/Seoul, America/New_York, Europe/Berlin) × 기준 시각 6개(DST 시작·종료 직전, 윤년 2월 포함), 조합마다 다음 실행 시각 20개. 1,440개 조합 중 두 버전 결과가 같은 1,416개가 모두 일치합니다(나머지 24개는 버전마다 다른 `31W`라 거부). `L`, `L-n`, `LW`, `L-nW`, `nW`, `#`, 범위 감김(`22-2`), 연도, DST의 없는·겹치는 시각을 포함합니다.
- 잘못된 표현식 55개는 모두 거부합니다(Quartz가 거부하는 것과 지원 범위 밖인 것). Quartz가 거부하는 표현식은 도구도 반드시 거부하는지 따로 검사합니다.
- CronTrigger 14개(시작 시각 밀리초, 종료 시각 경계, 레거시·사용자 지정·모르는 타임존), SimpleTrigger 12개(무한 반복, 종료 시각, 잘못된 값), JDK 타임존 ID 632개 전체의 오프셋, properties 15개가 모두 일치합니다.
- 결과는 `CronExpression.MAX_YEAR`(생성한 해 + 100)에 따라 먼 미래에서 달라질 수 있어 생성 날짜를 함께 남깁니다. 벡터 JSON은 레포에 커밋하고, CI는 Java 없이 Vitest로 비교합니다.

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
      행이 없으면 INSERT. INSERT한 행은 커밋 전까지 이 트랜잭션이 잠그고 있으므로 다시 SELECT하지 않음
      INSERT가 키 중복으로 실패하면(다른 쪽이 동시에 INSERT) ROLLBACK 후 1회 재시도
   d. 대상 행을 SELECT … FOR UPDATE [WAIT 5]로 잠그며 재조회하고 expected와 비교. 다르면 ROLLBACK, 409 STATE_CONFLICT (FR-CTL-00e)
   e. 상태 조건부 변경 (§7.3)
   f. 변경 후 상태 조회
   g. COMMIT
   h. dialect.afterLockedTx
5. 감사 로그 갱신 (result=success|failure, after, error_code)
```

- 잠금 범위 안에서는 대상 DB 호출만 하고, 다른 비동기 작업(SQLite, 외부 호출)은 하지 않습니다. Quartz 노드를 기다리게 하는 시간을 최소화하기 위해서입니다(PRD R3).
- 잠금 대기가 5초를 넘으면 `LOCK_TIMEOUT`, 그 밖의 DB 오류(교착 감지로 인한 롤백 포함)는 `TARGET_ERROR`로 응답합니다. Quartz와 같은 결과를 보장할 수 없는 요청은 `RESUME_IN_PAUSED_GROUP`(§7.4) 같은 명령별 오류 코드(409)로 거부합니다. 어떤 실패든 ROLLBACK하므로 대상 DB에는 아무것도 바뀌지 않습니다.
- 도구 프로세스가 트랜잭션 도중 죽으면 커넥션이 끊기면서 DB가 ROLLBACK합니다(NFR-REL-02). 기동할 때 `pending` 상태로 남은 감사 로그를 `failure(INTERRUPTED)`로 정리하고, 화면에 "결과 확인 필요"를 표시합니다.

### 7.2 잠금 규약과 동시성 근거

S1(B-08)에서 Quartz 2.3.2와 2.5.2 소스로 확인한 내용입니다. 두 버전의 동작은 같습니다.

**Quartz의 잠금 방식**

- 클러스터 모드에서는 항상 DB 행 잠금(`StdRowLockSemaphore`)을 씁니다(`JSS.initialize`에서 `isClustered()`이면 `setUseDBLocks(true)`). 잠금 SQL은 `SELECT * FROM {prefix}LOCKS WHERE SCHED_NAME = '<이름>' AND LOCK_NAME = ? FOR UPDATE`이고, 대기 시간 제한이 없습니다. 행이 없으면 INSERT하고 그대로 진행하며, 실패하면 1초 쉬고 최대 3번까지 다시 시도합니다(`StdRowLockSemaphore.executeSQL`).
- 잠금 이름은 `TRIGGER_ACCESS`와 `STATE_ACCESS` 두 가지입니다. 도구는 `TRIGGER_ACCESS`만 씁니다. `STATE_ACCESS`는 클러스터 체크인과 복구에만 쓰입니다(§9.2).
- 트랜잭션 격리 수준은 DB 기본값입니다(`txIsolationLevelSerializable=false`가 기본). Oracle과 PostgreSQL은 READ COMMITTED, MySQL과 MariaDB는 REPEATABLE READ입니다.

**`TRIGGER_ACCESS` 안에서 일어나는 작업** (`JSS`의 각 메서드가 `executeInLock(LOCK_TRIGGER_ACCESS, …)`로 실행)

| 작업 | 메서드 | 비고 |
| --- | --- | --- |
| 일시정지와 재개 | `pauseTrigger`, `pauseJob`, `pauseJobs`, `pauseTriggers`, `pauseAll`, `resumeTrigger`, `resumeJob`, `resumeJobs`, `resumeTriggers`, `resumeAll` | |
| 저장, 교체, 삭제 | `storeTrigger`, `storeJobAndTrigger`, `replaceTrigger`, `removeTrigger`, `removeJob` | `storeTrigger`는 `lockOnInsert=true`(기본) 또는 교체일 때만 잠금 |
| 발화와 완료 | `triggersFired`, `triggeredJobComplete`, `releaseAcquiredTrigger` | |
| misfire 처리 | `doRecoverMisfires` (MisfireHandler 스레드) | 잠금 전에 잠금 없이 건수를 먼저 셈(`doubleCheckLockMisfireHandler=true`) |
| 클러스터 복구 | `doCheckin` → `clusterRecover` | `STATE_ACCESS` 다음에 `TRIGGER_ACCESS` |
| **트리거 획득** | `acquireNextTriggers` | `acquireTriggersWithinLock=true`이거나 `batchTriggerAcquisitionMaxCount > 1`일 때만 잠금. 기본 설정에서는 **잠금 없음** |

**잠금 없는 트리거 획득** (`JSS.acquireNextTrigger`, 기본 설정)

1. 후보 조회: `TRIGGER_STATE='WAITING' AND NEXT_FIRE_TIME <= noLaterThan AND (MISFIRE_INSTR = -1 OR NEXT_FIRE_TIME >= 노드현재시각 - misfireThreshold)`. `noLaterThan`은 `노드현재시각 + idleWaitTime(기본 30초)`입니다(`QST.run`). 즉 misfire된 트리거는 획득하지 않고 MisfireHandler에 맡깁니다(§7.4).
2. 후보마다 `retrieveTrigger`로 트리거 전체를 **메모리로 읽습니다.**
3. `UPDATE … SET TRIGGER_STATE='ACQUIRED' WHERE … AND TRIGGER_STATE='WAITING'`. 0행이면 다음 후보로 넘어갑니다.
4. `FIRED_TRIGGERS`에 `ENTRY_STATE='ACQUIRED'` 행을 넣습니다. 이 행은 `JOB_NAME`, `JOB_GROUP`이 `NULL`이고 `IS_NONCONCURRENT`가 false입니다(`Delegate.insertFiredTrigger`에 job이 null로 전달됨).

획득한 트리거는 발화 시각까지 최대 `idleWaitTime`(30초) 동안 ACQUIRED로 남습니다. 발화 시각이 되면 `triggersFired`(잠금 안)가 다음을 합니다(`JSS.triggerFired`).

- DB의 상태가 ACQUIRED가 아니면(PAUSED, WAITING, 삭제됨 등) 발화하지 않고 null을 돌려줍니다. 노드는 `releaseAcquiredTrigger`로 `ACQUIRED→WAITING`, `BLOCKED→WAITING`(둘 다 조건부)을 시도하고 `FIRED_TRIGGERS` 행을 지웁니다(`QST.run`).
- ACQUIRED이면 2단계에서 **메모리에 읽어 둔 트리거 객체**로 `triggered()`를 호출해 다음 실행 시각을 계산하고, `storeTrigger(…, replaceExisting=true)`로 `TRIGGERS` 행 전체와 하위 테이블 행을 덮어씁니다.

**도구의 규약**

- 도구는 Quartz와 같은 `TRIGGER_ACCESS` 행을 잠근 트랜잭션 안에서만 쓰기를 합니다(§7.1 c). 잠금 대기는 5초로 제한합니다(Quartz 노드는 도구를 무기한 기다리지만, 도구의 트랜잭션은 짧음).
- 잠금을 잡은 뒤 대상 트리거 행을 `SELECT … FOR UPDATE`로 잠그고 상태를 다시 읽습니다(§7.1 d). 잠금 없는 획득의 3단계 UPDATE는 이 행 잠금을 기다렸다가, 도구가 커밋한 뒤 WHERE 조건을 다시 평가합니다. 도구가 PAUSED로 바꿨다면 0행이 되어 획득하지 않습니다.
- 상태 변경 UPDATE에는 항상 `WHERE TRIGGER_STATE IN (기대 상태들)`을 붙입니다. 행 잠금으로 이미 보호되지만, 잠금이 빠진 경로가 생겨도 잘못 덮어쓰지 않게 하는 이중 안전장치입니다. Quartz의 `pauseTrigger`는 상태를 읽은 뒤 조건 없는 UPDATE를 하는데, 도구의 방식은 그보다 엄격하고 결과는 같습니다.
- **ACQUIRED 트리거의 스케줄 컬럼을 바꿀 때는 상태도 반드시 ACQUIRED에서 벗어나게 합니다.** ACQUIRED로 남겨 두면 노드가 발화할 때 메모리의 옛 트리거로 행 전체를 덮어써 변경이 사라집니다. Quartz `rescheduleJob`도 트리거를 지우고 WAITING으로 다시 넣으므로 같은 결과입니다(§7.6). 일시정지와 삭제는 상태가 ACQUIRED에서 벗어나므로 문제가 없습니다.
- 남는 경합 창: 획득 2단계(읽기)와 3단계(UPDATE) 사이에 도구가 스케줄을 바꾸고 커밋하면, 노드는 옛 스케줄로 획득합니다. 이 창은 수 ms이고 Quartz 자체의 `rescheduleJob`에도 똑같이 있습니다(기본 설정의 Quartz가 감수하는 위험). 도구는 이 이상을 보장하지 않습니다.
- 교착: 도구는 항상 "잠금 행 → 대상 행" 순서로 잠급니다. 잠금 없는 획득은 잠금 행을 기다리지 않고 트리거 행을 하나만 성공적으로 잠그므로, 단일 트리거 명령에서는 교착 순환이 생기지 않습니다. 여러 행을 바꾸는 명령(잡, 그룹)은 MySQL의 REPEATABLE READ에서 획득 쪽의 실패한 UPDATE가 행 잠금을 남길 수 있어 교착이 생길 수 있습니다. Quartz 자체의 `pauseTriggers`도 같은 위험을 가집니다. DB가 교착을 감지하면 한쪽을 롤백합니다. 도구 쪽이 롤백되면 `TARGET_ERROR`(재시도 가능)로 응답하고 대상 DB는 바뀌지 않습니다. Quartz 쪽이 롤백되면 노드가 다음 루프에서 다시 획득합니다(`QST.run`의 `acquiresFailed` 처리).
- Quartz의 misfire 판정과 노드 장애 판정은 **노드의 시계**(`System.currentTimeMillis()`)를 씁니다. 도구는 DB 시각을 쓰므로, 노드와 DB의 시계 차이만큼 경계값 판정이 어긋날 수 있습니다. 도구는 경계값에 걸리는 판단을 하지 않도록 설계합니다(§7.4의 재개 거부 조건은 "지났는지"만 봄).

### 7.3 명령별 동작

Quartz 메서드와 같은 결과를 내는 것이 원칙입니다(FR-CTL-00d). 아래는 S1에서 Quartz 2.3.2, 2.5.2 소스로 확인한 동작입니다. 표에 적지 않은 상태(예: ERROR, COMPLETE)는 바꾸지 않습니다. 테스트 케이스는 부록 A에 있습니다.

| 명령 | 대응 Quartz API (근거) | 동작 |
| --- | --- | --- |
| `pauseTrigger` | `pauseTrigger` (`JSS.pauseTrigger`) | WAITING/ACQUIRED → PAUSED, BLOCKED → PAUSED_BLOCKED. `PAUSED_TRIGGER_GRPS`는 건드리지 않음 |
| `resumeTrigger` | `resumeTrigger` (`JSS.resumeTrigger`, `JSS.checkBlockedState`) | 행이 없거나 NEXT_FIRE_TIME이 없으면(`<= 0` 또는 NULL) 아무것도 하지 않음. 아니면 새 상태 = 같은 잡의 `FIRED_TRIGGERS` 행 중 `IS_NONCONCURRENT`가 참인 행이 있으면 BLOCKED, 없으면 WAITING. 이 값으로 PAUSED → 새 상태, PAUSED_BLOCKED → 새 상태(둘 다 조건부 UPDATE). 트리거 그룹이 일시정지 상태인지는 보지 않음. NEXT_FIRE_TIME은 바꾸지 않음(§7.4) |
| `pauseJob` / `resumeJob` | `pauseJob` / `resumeJob` (`JSS.pauseJob`, `JSS.resumeJob`) | 잡의 모든 트리거에 위 동작을 각각 적용 |
| `pauseTriggerGroup` | `pauseTriggers(GroupMatcher.groupEquals)` (`JSS.pauseTriggerGroup`) | 그룹의 WAITING/ACQUIRED → PAUSED, BLOCKED → PAUSED_BLOCKED 일괄 UPDATE. 그 뒤 `PAUSED_TRIGGER_GRPS`에 그룹 행이 없으면 INSERT. 트리거가 하나도 없는 그룹이어도 INSERT함 |
| `resumeTriggerGroup` | `resumeTriggers(GroupMatcher.groupEquals)` (`JSS.resumeTriggerGroup`) | `PAUSED_TRIGGER_GRPS`에서 그룹 행 DELETE 후, 그룹의 모든 트리거에 `resumeTrigger` 적용. 그룹이 일시정지 상태가 아니었어도 개별로 일시정지된 트리거까지 모두 재개됨 |
| `pauseJobGroup` / `resumeJobGroup` | `pauseJobs` / `resumeJobs` (`JSS.pauseJobs`, `JSS.resumeJobs`) | 잡 그룹(`JOB_GROUP = ?`)의 잡마다 pauseJob/resumeJob. JDBC JobStore는 잡 그룹 일시정지를 저장하지 않으므로(`RAMJobStore`와 다름) 이후 추가되는 잡에는 적용되지 않음(화면에 안내) |
| `pauseAll` / `resumeAll` (P1) | `pauseAll` / `resumeAll` (`JSS.pauseAll`, `JSS.resumeAll`) | pauseAll: `TRIGGERS`에 있는 DISTINCT 그룹마다 pauseTriggerGroup 후 `_$_ALL_GROUPS_PAUSED_$_` INSERT(없을 때). resumeAll: `TRIGGERS`에 있는 그룹마다 resumeTriggerGroup 후 `_$_ALL_GROUPS_PAUSED_$_` DELETE. 트리거가 없는 그룹의 `PAUSED_TRIGGER_GRPS` 행은 resumeAll 뒤에도 남음 |
| `triggerJob` | `triggerJob(jobKey)` (`QS.triggerJob`) | §7.5 |
| `updateCronSchedule` | `rescheduleJob` 상당 (`QS.rescheduleJob`, `JSS.replaceTrigger`) | §7.6 |
| `updateSimpleSchedule` | `rescheduleJob` 상당 | §7.6 |
| `deleteTrigger` | `unscheduleJob` (`JSS.removeTrigger`) | 하위 테이블 행(SIMPLE/CRON/SIMPROP 중 하나, 없으면 BLOB)과 TRIGGERS 행 삭제. 잡이 durable이 아니고 남은 트리거가 0개면 JOB_DETAILS도 삭제. 실행 중인 트리거를 지워도 노드는 실행 완료 처리(`triggeredJobComplete`)에서 0행 UPDATE만 하고 오류 없이 끝남 |
| `deleteJob` | `deleteJob` (`QS.deleteJob` → 트리거마다 `removeTrigger`, 마지막에 `JSS.removeJob`) | 잡의 모든 트리거와 하위 행, JOB_DETAILS 삭제. Quartz는 트리거마다 트랜잭션을 나누지만 도구는 한 트랜잭션으로 처리. 최종 상태는 같음. `FIRED_TRIGGERS`는 건드리지 않음(실행 중이면 노드가 완료 후 지움). 삭제 전 스냅샷을 감사 로그 `before_json`에 저장(JOB_DATA는 64KB까지 base64) |

**확인된 세부 규칙**

- **BLOCKED 판정**(`JSS.checkBlockedState`): 현재 상태가 WAITING이나 PAUSED일 때만 BLOCKED/PAUSED_BLOCKED로 바뀝니다. 획득 단계의 ACQUIRED 행은 `JOB_NAME`이 NULL이라 조회되지 않으므로, 실제로는 **실행 중(EXECUTING)인 행**만 판정에 쓰입니다. Quartz는 조회된 첫 행의 `IS_NONCONCURRENT`만 보지만, 같은 잡의 행은 모두 같은 값이므로 도구는 `EXISTS (… AND IS_NONCONCURRENT = 참)`으로 판정합니다.
- **그룹 이름 비교 방식(의도된 차이)**: Quartz는 `GroupMatcher.groupEquals`를 넘겨도 일괄 UPDATE(`UPDATE_TRIGGER_GROUP_STATE_FROM_STATES`), 그룹 목록 조회(`SELECT_TRIGGER_GROUPS_FILTERED`), `PAUSED_TRIGGER_GRPS` 삭제(`DELETE_PAUSED_TRIGGER_GROUP`)에서 `TRIGGER_GROUP LIKE ?`를 이스케이프 없이 씁니다(`Delegate.toSqlLikeClause`). 그래서 그룹 이름에 `_`나 `%`가 있으면 다른 그룹까지 일시정지될 수 있습니다(예: `A_B`를 일시정지하면 `AXB`도 일시정지). 반면 트리거 목록 조회(`SELECT_TRIGGERS_IN_GROUP`)는 `=`를 씁니다. 도구는 모든 곳에서 `=`로 비교합니다. 이름이 와일드카드로 겹치는 그룹이 있을 때만 결과가 다르며, PRD FR-CTL-00d의 예외로 명시합니다.
- **트리거 저장 시 상태 결정**(`JSS.storeTrigger`, `forceState=false`일 때): 트리거 그룹이 `PAUSED_TRIGGER_GRPS`에 있으면 PAUSED. 없더라도 `_$_ALL_GROUPS_PAUSED_$_`가 있으면 **그 그룹 행을 `PAUSED_TRIGGER_GRPS`에 INSERT하고** PAUSED. 그 뒤 잡이 동시 실행 금지(`JOB_DETAILS.IS_NONCONCURRENT`)이면 BLOCKED 판정을 적용합니다. 이 규칙은 즉시 실행(§7.5), 스케줄 수정(§7.6), misfire 처리(§7.4)에 쓰입니다.

### 7.4 재개 시 misfire 처리 (FR-CTL-04)

재개할 때 NEXT_FIRE_TIME이 이미 지났더라도, 도구는 상태만 바꾸고 다음 실행 시각은 다시 계산하지 않습니다. 이렇게 하면 misfire 처리 방식(SimpleTrigger만 6종)과 Java 직렬화된 캘린더를 이식하지 않아도 됩니다.

**Quartz `resumeTrigger`의 실제 동작** (`JSS.resumeTrigger`, `JSS.updateMisfiredTrigger`)

호출한 스케줄러 인스턴스가 실행 중(`schedulerRunning`)이고 NEXT_FIRE_TIME이 현재보다 과거이면, `NEXT_FIRE_TIME <= 노드현재시각 - misfireThreshold`인지 봅니다. 그렇다면 **같은 트랜잭션 안에서** `updateAfterMisfire(캘린더)`로 다음 실행 시각을 다시 계산하고, `storeTrigger(…, forceState=true)`로 저장합니다(그룹 일시정지는 보지 않음). 임계값 안이면 상태만 바꿉니다. 스탠바이 상태인 인스턴스로 호출하면 misfire 처리를 하지 않습니다.

**도구에 위임했을 때 일어나는 일**

- 재개된 트리거는 WAITING이고 NEXT_FIRE_TIME이 지난 값입니다. 획득 조회는 `NEXT_FIRE_TIME >= 노드현재시각 - misfireThreshold` 조건 때문에 이 트리거를 집지 않습니다(§7.2). 그래서 잘못 발화하지 않습니다.
- 각 노드의 MisfireHandler가 `misfireThreshold`(기본 60초) 간격으로 `TRIGGER_STATE='WAITING' AND MISFIRE_INSTR <> -1 AND NEXT_FIRE_TIME < 노드현재시각 - misfireThreshold`인 트리거를 찾아(`SELECT_HAS_MISFIRED_TRIGGERS_IN_STATE`, 한 번에 최대 20개), Quartz `resumeTrigger`와 같은 `updateAfterMisfire`를 적용합니다(`JSS.recoverMisfiredJobs`, `doUpdateOfMisfiredTrigger`). 다음 실행 시각이 없으면 COMPLETE로 저장합니다.
- 임계값 안이면 일반 획득 경로로 바로 발화합니다. Quartz도 이 경우 상태만 바꾸므로 같습니다.
- `MISFIRE_INSTR = -1`(IGNORE_MISFIRE_POLICY)은 MisfireHandler 대상이 아니고 획득 조회에 바로 잡힙니다. Quartz `resumeTrigger`도 `updateAfterMisfire`가 아무것도 바꾸지 않으므로 같습니다.
- **적용 시점**: 최대 `misfireThreshold`(기본 60초)만큼 늦을 수 있습니다. 노드가 여러 대면 각자 MisfireHandler를 돌리므로 대개 더 빠릅니다. 노드가 스탠바이여도 MisfireHandler는 돕니다. 활성 노드가 없으면 노드가 다시 뜰 때까지 반영되지 않습니다.
- **BLOCKED로 재개된 경우**: MisfireHandler는 WAITING만 보므로, 실행 중인 잡이 끝나 BLOCKED → WAITING이 된 뒤(`JSS.triggeredJobComplete`) 처리됩니다. Quartz는 BLOCKED로 두면서 시각을 바로 다시 계산합니다. 어느 쪽이든 잡이 끝나기 전에는 발화하지 않으므로 최종 결과는 같습니다.

**결과가 달라지는 경우와 대응**

MisfireHandler는 `storeTrigger(…, forceState=false)`로 저장하므로 그룹 일시정지를 다시 적용합니다. 그래서 **일시정지된 그룹(또는 전체 일시정지) 안의 트리거를 개별로 재개하고 그 트리거의 실행 시각이 misfire 임계값보다 지나 있으면**, Quartz는 WAITING으로 두지만 위임 방식에서는 MisfireHandler가 다시 PAUSED로 만듭니다. 도구는 이 경우 결과가 Quartz와 같다고 보장할 수 없으므로 **명령을 거부합니다**.

- 거부 조건: 재개 대상 트리거의 그룹이 `PAUSED_TRIGGER_GRPS`에 있거나 `_$_ALL_GROUPS_PAUSED_$_`가 있고, NEXT_FIRE_TIME이 dbNow보다 과거. 시계 차이 때문에 임계값 경계를 정확히 판정할 수 없으므로 "지났는지"만 봅니다.
- 오류 코드 `RESUME_IN_PAUSED_GROUP`(409). `resumeJob`, `resumeJobGroup`은 대상 중 하나라도 해당하면 전체를 거부하고, 미리보기에서 해당 트리거 목록과 "그룹을 먼저 재개하세요"를 보여줍니다.
- `resumeTriggerGroup`과 `resumeAll`은 그룹 행을 먼저 지우므로 해당하지 않습니다.

화면에는 "재개됨. 지난 실행은 Quartz 노드가 misfire 정책에 따라 최대 1분(misfireThreshold) 안에 처리합니다"라고 안내합니다. PRD FR-CTL-04에 반영했습니다(§13 제안 1은 PRD v0.3, 제안 7은 PRD v0.5).

### 7.5 즉시 실행 (FR-CTL-05)

Quartz `triggerJob(jobKey)`과 같은 일회성 트리거를 INSERT합니다. 근거는 `QS.triggerJob`(이름과 저장), `TriggerBuilder.build`와 `SimpleScheduleBuilder`(기본값), `Delegate.insertTrigger`(컬럼 값), `JSS.storeTrigger`(상태)입니다. Quartz는 `storeTrigger(trig, false)`를 `lockOnInsert=true`(기본)이면 `TRIGGER_ACCESS` 안에서 실행합니다.

| 컬럼 | Quartz 값 | 도구 값 |
| --- | --- | --- |
| TRIGGER_NAME | `MT_` + `Long.toString(\|난수 long\|, 30~36진법)`. 키가 겹치면 이름을 다시 만들어 재시도 | 같은 형식. 겹치면 다시 생성 |
| TRIGGER_GROUP | `DEFAULT` | 같음 |
| DESCRIPTION | NULL | `quartz-admin: <사용자명>` (추적용, **의도된 차이**) |
| TRIGGER_TYPE | `SIMPLE` (+ `SIMPLE_TRIGGERS`: REPEAT_COUNT 0, REPEAT_INTERVAL 0, TIMES_TRIGGERED 0) | 같음 |
| START_TIME, NEXT_FIRE_TIME | 노드 현재 시각(`TriggerBuilder`의 기본 `startTime = new Date()`, `computeFirstFireTime`은 START_TIME) | 대상 DB 현재 시각 |
| PREV_FIRE_TIME / END_TIME | -1 / 0 | 같음 |
| PRIORITY / MISFIRE_INSTR | 5 / 0(SMART_POLICY. 반복 0회 SimpleTrigger에서는 FIRE_NOW로 동작) | 같음 |
| JOB_DATA, CALENDAR_NAME | NULL(빈 맵이면 NULL) / NULL | 같음 |
| TRIGGER_STATE | §7.3 "트리거 저장 시 상태 결정" 규칙 | 같은 규칙. 기본 WAITING. `DEFAULT` 그룹이 일시정지면 PAUSED. 전체 일시정지만 걸려 있으면 `PAUSED_TRIGGER_GRPS`에 `DEFAULT` 행을 INSERT하고 PAUSED. 잡이 동시 실행 금지이고 실행 중이면 BLOCKED(또는 PAUSED_BLOCKED) |

- 잡이 없으면 Quartz는 `JobPersistenceException`을 냅니다. 도구는 404 `NOT_FOUND`로 응답하고 아무것도 넣지 않습니다.
- 발화 후 처리(`JSS.triggerFired`, `JSS.triggeredJobComplete`): 발화할 때 다음 실행 시각이 없으므로 COMPLETE로 저장되고, 실행이 끝나면 `DELETE_TRIGGER` 지시로 삭제됩니다. 실행 도중 노드가 죽으면 살아남은 노드의 `clusterRecover`가 실행 기록이 남지 않은 COMPLETE 트리거를 지웁니다.
- 도구와 노드의 시계가 misfireThreshold 이상 어긋나 있으면(DB 시각이 노드보다 늦으면) 넣자마자 misfire로 보일 수 있습니다. 이때도 MisfireHandler가 FIRE_NOW로 처리하므로 한 번 실행됩니다(최대 1분 지연). 시계 차이 경고(§8.4)가 이 상황을 알려 줍니다.
- 차등 테스트(B-19)는 TRIGGER_NAME, START_TIME, NEXT_FIRE_TIME, DESCRIPTION을 빼고 비교합니다.

### 7.6 스케줄 수정 (FR-CTL-06, FR-CTL-07)

**Quartz `rescheduleJob`의 실제 동작** (`QS.rescheduleJob`, `JSS.replaceTrigger`)

새 트리거의 `validate()`와 `computeFirstFireTime(캘린더)`를 실행해 null이면 거부합니다. 그 뒤 `replaceTrigger`가 잠금 안에서 기존 트리거와 하위 행을 지우고, 새 트리거를 `storeTrigger(…, state=WAITING, forceState=false)`로 넣습니다. 그 결과는 다음과 같습니다.

- 개별 일시정지(PAUSED, PAUSED_BLOCKED)가 풀립니다(**확인됨**). 그룹 일시정지와 전체 일시정지는 §7.3 저장 규칙으로 다시 적용됩니다.
- ACQUIRED, ERROR, COMPLETE도 모두 WAITING(또는 그룹 규칙에 따라 PAUSED, BLOCKED)으로 바뀝니다. ACQUIRED였던 트리거는 노드의 `triggersFired`에서 상태가 맞지 않아 발화하지 않고 해제됩니다.
- PREV_FIRE_TIME, TIMES_TRIGGERED 같은 값은 넘긴 새 트리거 객체의 값이 됩니다(보통 -1, 0).

**도구의 동작**

새 행을 넣지 않고 기존 행을 UPDATE합니다. 키, 잡, DESCRIPTION, PRIORITY, MISFIRE_INSTR, CALENDAR_NAME, JOB_DATA, END_TIME, PREV_FIRE_TIME은 그대로 둡니다.

- **CRON**: `CRON_TRIGGERS`의 CRON_EXPRESSION과 TIME_ZONE_ID를 바꾸고, `TRIGGERS.NEXT_FIRE_TIME`을 `getFireTimeAfter(max(dbNow, START_TIME - 1000))`으로 다시 계산합니다(END_TIME 반영. `CronTriggerImpl.computeFirstFireTime`의 `startTime - 1000` 규칙과 같음). START_TIME은 바꾸지 않습니다. 결과가 null이면(더 이상 발화하지 않음) 거부합니다.
  - Quartz 대응: `rescheduleJob(key, old.getTriggerBuilder().withSchedule(cronSchedule(expr).inTimeZone(tz)).startAt(max(now, START_TIME)).build())`에 MISFIRE_INSTR을 기존 값으로 둔 것. 차이는 START_TIME 컬럼(과거 값이면 Quartz는 now)과 PREV_FIRE_TIME뿐이며, 두 값은 CronTrigger의 이후 계산에 쓰이지 않습니다.
- **SIMPLE**: REPEAT_INTERVAL과 REPEAT_COUNT를 바꾸고, TIMES_TRIGGERED=0, START_TIME=`startAt`(기본은 DB 현재 시각), NEXT_FIRE_TIME=START_TIME으로 둡니다. "지금부터 새 간격으로 다시 시작"하는 의미입니다.
  - 검증은 Quartz와 같게 합니다: REPEAT_COUNT ≥ -1(-1은 무한), REPEAT_COUNT ≠ 0이면 REPEAT_INTERVAL ≥ 1(`SimpleTriggerImpl.validate`), END_TIME이 있으면 START_TIME < END_TIME. 추가로 `startAt`이 dbNow보다 과거면 거부합니다(넣자마자 misfire가 되는 것을 막음).
  - Quartz 대응: `rescheduleJob(key, old.getTriggerBuilder().withSchedule(simpleSchedule().withIntervalInMilliseconds(i).withRepeatCount(c)).startAt(startAt).build())`에 MISFIRE_INSTR을 기존 값으로 둔 것. 차이는 PREV_FIRE_TIME뿐입니다(SimpleTrigger의 이후 계산은 START_TIME과 TIMES_TRIGGERED만 씀).
- **상태 결정**: Quartz `replaceTrigger`의 저장 규칙을 따르되, 개별 일시정지만 유지합니다.
  1. 현재 상태가 PAUSED나 PAUSED_BLOCKED이면 기준 상태를 PAUSED로, 아니면 WAITING으로 둡니다.
  2. 기준 상태가 WAITING이면 §7.3 "트리거 저장 시 상태 결정"의 그룹 규칙을 적용합니다(전체 일시정지면 그룹 행 INSERT 포함).
  3. 잡이 동시 실행 금지이면 BLOCKED 판정을 적용합니다.
  - 그래서 ACQUIRED → WAITING이 됩니다. §7.2의 규약대로 노드가 옛 스케줄로 덮어쓰는 것을 막는 핵심 규칙입니다. ERROR → WAITING도 Quartz와 같습니다(미리보기에서 "오류 상태가 해제됩니다"라고 경고). COMPLETE 트리거는 곧 삭제될 트리거이므로 거부합니다.
- **개별 일시정지 유지**: 개별로 일시정지된 트리거는 수정 후에도 PAUSED입니다. Quartz `rescheduleJob`은 이를 해제하므로 운영자의 기대에 맞추기 위한 **의도된 차이**입니다(§13 제안 5, PRD FR-CTL-00d).
- **캘린더 연결 트리거**: CALENDAR_NAME이 있는 트리거는 수정할 수 없습니다. 캘린더는 Java 직렬화 BLOB이라 제외 시간을 계산할 수 없기 때문입니다(§13 제안 2).
- **미리보기**: `POST /cron/preview { expression, timeZone, count: 5 }`가 `@qa/core`로 계산합니다. 화면은 입력할 때마다(300ms 디바운스) 호출합니다.

## 8. 조회 설계 (FR-VIEW)

### 8.1 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/schedulers` | 대시보드 목록. 스냅샷 캐시 기반(§8.4). `env`(정확히 일치, 소문자), `tag`(포함), `q`(스케줄러 표시 이름·SCHED_NAME·접속 이름 부분 일치) 필터. 응답은 `{ generatedAt, items, envs, tags }`이며 `envs`·`tags`는 필터 선택지(필터와 무관하게 전체에서) |
| GET | `/schedulers/:id` | 상세. 설정·감지 정보에 접속 요약(이름, 환경, 태그, 읽기 전용, 쓰기 가능), 마지막 스냅샷, 열린 알림 수를 붙인다 |
| GET | `/schedulers/:id/nodes` | 실시간 노드 목록 |
| GET | `/schedulers/:id/paused-groups` | 일시정지된 트리거 그룹 |
| GET | `/schedulers/:id/jobs` | `group`, `q`, `page`, `size`(최대 200), `sort` |
| GET | `/schedulers/:id/jobs/detail?group=&name=` | 잡 상세, 트리거 목록, JobDataMap(가능한 경우) |
| GET | `/schedulers/:id/triggers` | `state[]`, `type[]`, `group`, `q`, `page`, `size`, `sort`(`key`/`nextFireTime`) |
| GET | `/schedulers/:id/executing` | FIRED_TRIGGERS 기반 실행 중 목록 |

- 대시보드 카드(`SchedulerSummaryDto`)는 스케줄러 표시 이름·SCHED_NAME·prefix·기대 노드 수·감시 주기, 접속 요약, 스냅샷, 열린 알림 수입니다. 정렬은 접속 이름·표시 이름 순입니다.
- 잡과 트리거 키는 `/` 같은 문자를 포함할 수 있으므로 경로가 아니라 쿼리 파라미터로 받습니다.
- 목록은 OFFSET 페이지네이션입니다(`page` 1부터, `size` 기본 50·최대 200). 응답은 `{ dbNow, items, total, page, size }`입니다. 스케줄러당 트리거 10,000개 규모면 충분합니다. 같은 조건의 `COUNT(*)`로 전체 개수를 함께 돌려줍니다.
- 조회는 대상 DB에서 직접 읽습니다(조회 제한 10초). 요청마다 같은 커넥션에서 DB 현재 시각을 먼저 읽어 응답의 `dbNow`에 넣고, 화면은 이 값을 데이터 기준 시각으로 표시합니다(FR-VIEW-06). 노드 활성 판정, 경과 시간도 이 값을 기준으로 계산합니다.
- 상태를 바꾸지 않으므로 감사 로그를 남기지 않습니다. 대상 DB 오류는 §5.6대로 응답합니다.
- 구현: 쿼리는 `@qa/store`의 `views/`(`listNodes`, `listPausedGroups`, `listJobs`, `getJobDetail`, `listTriggers`, `listExecuting`), API는 `apps/api/src/views/`입니다. 테이블은 `TableSet`(감지한 `table_schema`와 실제 테이블 이름), 선택 컬럼은 `features_json`으로 넣고 뺍니다.

| 경로 | 응답 내용 |
| --- | --- |
| `nodes` | 인스턴스명, 마지막 체크인 시각, 체크인 간격, 활성 여부(§9.2, 스케줄러의 `checkin_multiplier`), 마지막 체크인 후 경과 시간 |
| `paused-groups` | 일시정지된 그룹 목록. `pauseAll` 표시 행(`_$_ALL_GROUPS_PAUSED_$_`)은 목록에서 빼고 `allPaused`로 알립니다 |
| `jobs` | 그룹, 이름, 잡 클래스, 설명, durable, 동시 실행 금지, 데이터 갱신, 복구 요청, 트리거 수. 정렬은 그룹·이름 |
| `jobs/detail` | 잡, 연결된 트리거 전체(목록과 같은 형식), JobDataMap 판정(§8.3). 없는 잡은 404 |
| `triggers` | 그룹, 이름, 대상 잡, 설명, 타입, 상태, 다음·이전 실행 시각, 시작·종료 시각, 우선순위, `MISFIRE_INSTR` 원래 값, 캘린더, 일정(CRON: 표현식·타임존, SIMPLE: 반복 횟수·간격·실행 횟수, CAL_INT·DAILY_I: `SIMPROP_TRIGGERS` 원래 값) |
| `executing` | `FIRED_TRIGGERS` 행: 엔트리 ID, 트리거·잡 키, 인스턴스, 상태(EXECUTING/ACQUIRED 등), 실행 시각, 예정 시각, 우선순위, 경과 시간, `stale` |

- 시각 컬럼은 §5.4대로 `NULL`과 0 이하를 `null`로 바꿉니다. 화면은 사용자 타임존으로 표시하고 CRON 트리거의 타임존을 함께 보여 줍니다(FR-VIEW-09). `MISFIRE_INSTR`의 의미는 트리거 타입마다 달라 화면이 라벨로 바꿉니다.
- **오래된 실행 기록**(`stale`): 활성 노드가 아닌 인스턴스의 `FIRED_TRIGGERS` 행입니다. 살아 있는 노드의 ClusterManager가 복구하기 전이거나 클러스터 전체가 내려간 경우입니다. 도구는 표시만 하고 지우지 않습니다(PRD FR-CTL-12 삭제, §13 제안 3).

- **화면**(B-16, `apps/web`)
  - 대시보드 `/`: 스냅샷 카드(상태 배지, 활성/전체 노드와 기대 노드 수, 트리거·실행 중·열린 알림 수, 상태별 트리거 배지, 마지막 감시 시각). prod 카드는 위에 빨간 띠를 둡니다(NFR-UX-02). 연결 불가 카드는 원인과 연속 실패 수, "마지막으로 본 값" 기준 시각을 함께 보여 줍니다. 시계 차이가 30초를 넘으면 경고 문구를 붙입니다.
  - 스케줄러 상세 `/scheduler?id=&tab=`: 탭(트리거, 잡, 실행 중, 노드, 일시정지 그룹)마다 대상 DB에서 읽고, 표 위에 대상 DB 시각을 표시합니다. 트리거 탭은 상태·타입 여러 개 선택, 그룹(정확히 일치), 검색어, 정렬을 지원합니다.
  - 잡 상세 `/job?scheduler=&group=&name=`: 잡 정보, 연결된 트리거, JobDataMap(값은 기본으로 가림, Java 직렬화는 표시 불가 안내).
  - 시각은 브라우저 타임존으로 보여 주고, CRON 트리거의 타임존이 다르면 그 타임존 시각을 아래 줄에 함께 씁니다(FR-VIEW-09). Intl이 모르는 Java 타임존 ID(예: `EST`)는 이름만 씁니다.
  - 자동 새로고침(끔, 10초, 30초 기본, 1분)과 수동 새로고침을 화면 위에 둡니다. 선택한 주기는 브라우저에 저장합니다(FR-VIEW-06).

### 8.2 주요 쿼리

- 트리거 목록: `TRIGGERS t LEFT JOIN CRON_TRIGGERS LEFT JOIN SIMPLE_TRIGGERS` (+ `SIMPROP_TRIGGERS`가 있으면 표시용으로). 조인 조건은 세 키 컬럼(SCHED_NAME, TRIGGER_NAME, TRIGGER_GROUP)이며 하위 테이블의 기본키를 씁니다.
- 필터: 상태와 타입은 `IN`(여러 개), 그룹은 **정확히 일치**(`=`)입니다. 그룹명에 `%`, `_`, `/`가 있어도 그 그룹만 찾습니다.
- 검색: `UPPER(col) LIKE UPPER(?) ESCAPE '!'`로 부분 일치합니다. 트리거는 이름·그룹·잡 이름, 잡은 이름·그룹·클래스에 겁니다. 검색어의 `%`, `_`, `!`는 앞에 `!`를 붙여 글자 그대로 찾습니다. 이스케이프 문자를 `\`가 아니라 `!`로 정한 이유는 MySQL이 문자열 리터럴 안의 `\`를 다시 이스케이프해야 해서, DB 4종에서 같은 SQL을 쓰기 위해서입니다. 컬럼마다 바인드를 따로 씁니다(MySQL의 `?`는 번호로 다시 가리킬 수 없음).
- 정렬: `key`는 그룹·이름, `nextFireTime`은 다음 실행 시각이 없는 트리거(`NULL`, -1)를 뒤로 보낸 뒤(`CASE WHEN NEXT_FIRE_TIME > 0 …`) 시각·그룹·이름 순입니다. 정렬 끝에 항상 키 컬럼을 둬 페이지가 겹치지 않습니다.
- 잡의 트리거 수: `JOB_DETAILS`에서 `(SELECT COUNT(*) FROM TRIGGERS WHERE … JOB_NAME, JOB_GROUP)` 상관 서브쿼리로 셉니다(`IDX_QRTZ_T_J`). 목록에서는 `JOB_DATA`(BLOB)를 읽지 않습니다.
- 상태별 개수: `SELECT TRIGGER_STATE, COUNT(*) … GROUP BY TRIGGER_STATE`. Quartz 공식 스크립트의 `IDX_QRTZ_T_STATE` 인덱스를 씁니다(대시보드, B-15).
- 성능(B-14 통합 테스트, Oracle Free 23, 트리거 10,005개): 정렬·필터·검색·마지막 페이지를 섞은 목록 요청 40회가 p50 8ms, p95 17ms였습니다(DB 시각 조회 포함).

### 8.3 JobDataMap 표시 (FR-VIEW-08)

- BLOB이 `0xACED`(Java 직렬화 매직 넘버)로 시작하면 `java-serialized`(표시 불가)로 응답합니다. 클래스 정보 없이 읽을 수 없기 때문입니다.
- Quartz `useProperties=true`면 `java.util.Properties` 텍스트로 저장됩니다. `@qa/core`의 `parseJavaPropertiesBytes`로 파싱해 키 순서로 정렬한 키-값 목록(`properties`)을 돌려줍니다.
- 탭·줄바꿈·폼피드 외의 제어 문자가 있거나 파싱에 실패하면 `unreadable`, BLOB이 없으면 `empty`입니다. 어느 경우에도 원본 바이트는 돌려주지 않습니다.
- 비밀값이 들어 있을 수 있으므로 화면에서는 기본으로 값을 가리고, 펼치면 보이게 합니다(B-16).

### 8.4 대시보드 스냅샷

- 감시 루프(§9)가 주기마다 스케줄러별 요약(상태별 트리거 수, 노드, 실행 중 수, DB 시각, 시계 차이, 오류)을 `scheduler_snapshots`에 저장합니다.
- 대시보드는 대상 DB를 직접 조회하지 않고 이 캐시만 읽습니다. 그래서 연결할 수 없는 DB가 있어도 응답 시간이 일정합니다(NFR-PERF-01, FR-VIEW-07).
- 도구 서버와 대상 DB의 시계 차이가 30초를 넘으면 스케줄러 카드에 경고를 표시합니다.
- B-16 확인(빌드한 API, 연결할 수 없는 스케줄러 2개와 정상 스케줄러 1개): `GET /schedulers` 40회 p95 2ms, 브라우저에서 대시보드 첫 화면이 데이터까지 약 50ms 안에 그려졌습니다(NFR-PERF-01 목표 3초).
- 상태(`status`)는 감시할 때 정합니다(`apps/api/src/monitor/health.ts`). §9.2 기본 규칙과 같은 기준이며, 알림 엔진(B-24)이 붙으면 열린 알림과 함께 다시 정할 수 있습니다.
  - `unreachable`: 감시가 실패함(연결·인증·시간 초과·대상 DB 오류)
  - `critical`: 활성 노드 0개 또는 ERROR 트리거가 있음
  - `warning`: 활성 노드가 기대 노드 수보다 적음, 연체 트리거가 있음, 시계 차이 30초 초과
  - `ok`: 그 밖
- 시계 차이는 `DB 시각 - (조회 시작 + 끝) / 2`입니다. 왕복 시간의 절반만큼 오차가 있습니다.
- 감시가 실패하면 상태·오류 코드·문구·`polled_at`만 바꾸고 `consecutive_failures`를 하나 늘립니다. 마지막으로 성공한 개수·노드·DB 시각은 그대로 둬서 대시보드가 "마지막으로 본 값"을 보여 줄 수 있게 합니다. 성공하면 오류를 지우고 연속 실패를 0으로 되돌립니다.
- 오류 문구는 §5.6의 고정 문구만 남깁니다. 회차 제한을 넘으면 `TARGET_TIMEOUT`, 처리하지 못한 예외는 `INTERNAL_ERROR`와 고정 문구입니다.

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
- 구현(`apps/api/src/monitor/`, 수집 쿼리는 `@qa/store`의 `collectMonitorData`):
  - **시점**(`MonitorLoop`): 스케줄러마다 타이머가 따로 있고, 다음 회차는 **계획 시각 + 주기**로 회차를 시작할 때 미리 잡습니다. 한 스케줄러의 감시가 느리거나 응답이 없어도 그 스케줄러의 다음 회차만 건너뛰고(이전 회차가 끝나지 않았으면 겹쳐 돌리지 않음), 다른 스케줄러의 시점은 밀리지 않습니다. 동시에 도는 회차가 `QA_MONITOR_CONCURRENCY`개를 넘으면 대기열에서 기다립니다.
  - **첫 회차**: 기동하면 메타 저장소의 모든 스케줄러를 등록하고, 첫 회차를 `min(주기, 15초)` 안의 무작위 지터 뒤에 돌립니다. 재시작해도 감시가 저절로 이어지고, 대시보드 값이 15초 안에 새로 채워집니다.
  - **변경 반영**: 접속·스케줄러 관리가 `SchedulerEvents`로 알립니다. 등록하면 바로 한 번 감시하고, 설정을 바꾸면 주기를 다시 읽고(남은 시간이 새 주기보다 길면 앞당김), 접속 정보를 바꾸면 그 접속의 스케줄러를 바로 다시 감시하며, 삭제하면 감시에서 뺍니다. 감시 1회는 매번 메타 저장소에서 스케줄러·접속 행을 새로 읽으므로 테이블 이름이나 판정 기준 변경도 다음 회차부터 반영됩니다.
  - **회차 제한**: 대상 DB 조회 전체를 30초로 제한합니다. 접속별 풀(§5.2)이 연결 10초·쿼리 10초(어댑터 강제 제한 포함) 안에 끝내므로, 응답 없는 대상도 그 스케줄러의 회차만 실패합니다.
  - **확장 지점**(`MonitorHooks`): 스냅샷을 저장한 같은 SQLite 트랜잭션 안에서 등록된 훅에 결과(`ok`면 수집 값 전체, 실패면 실패 스냅샷)를 동기로 넘깁니다. 알림 규칙 평가(B-24)가 여기에 붙습니다. 훅이 던지면 그 회차의 쓰기 전체가 롤백되고 실패로 남습니다.
  - **`known_nodes`**: 감시에서 본 노드마다 `first_seen_at`(처음 본 시각), `last_seen_at`, 마지막 체크인 시각·간격을 갱신합니다. 사라진 노드의 행은 지우지 않습니다(노드 이탈 판정용).
- 실제 수집 쿼리(왕복 7회, 모두 조회만): DB 시각, 상태별 개수(`GROUP BY TRIGGER_STATE`), `SCHEDULER_STATE`, 연체 수(`COUNT`), 연체 상위 50개(연체가 있을 때만), ERROR·BLOCKED·PAUSED_BLOCKED 트리거 목록(최대 500개, 그룹·이름 순), `FIRED_TRIGGERS` 개수. 연체 기준은 `NEXT_FIRE_TIME > 0 AND NEXT_FIRE_TIME < dbNow - (misfire_threshold_ms + overdue_grace_ms)`이고 상태는 WAITING·ACQUIRED입니다.
- B-15 확인(빌드한 API, 실제 테스트베드): 연결할 수 없는 스케줄러가 매 회차 실패하는 동안 정상 스케줄러는 60.007초 간격으로 감시됐고, API를 재시작하자 두 스케줄러 모두 3~6초 안에 감시가 다시 시작됐습니다.
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
  - S1에서 확인한 Quartz 동작(**확인됨**, `JSS.ClusterManager`, `doCheckin`, `findFailedInstances`, `calcFailedIfAfter`, `clusterRecover`):
    - 각 노드는 `clusterCheckinInterval`(기본 7.5초)마다 체크인합니다. 먼저 잠금 없이 자기 행의 LAST_CHECKIN_TIME을 갱신하면서 다른 노드를 검사하고, 장애 노드가 보이면 `STATE_ACCESS`와 `TRIGGER_ACCESS`를 차례로 잠근 뒤 다시 확인하고 복구합니다.
    - 장애 판정: `노드현재시각 > LAST_CHECKIN_TIME + max(CHECKIN_INTERVAL, 노드현재시각 - 자기 마지막 체크인) + 7500ms`. 기본값이면 죽은 노드의 마지막 체크인 뒤 약 15초가 지나면 장애로 보고, 그다음 체크인(최대 7.5초 뒤)에서 복구합니다. 따라서 행은 대개 15~23초 안에 사라집니다.
    - 복구 내용: 죽은 노드의 `FIRED_TRIGGERS` 행마다 ACQUIRED 트리거를 WAITING으로 되돌리고, 동시 실행 금지 잡의 BLOCKED → WAITING, PAUSED_BLOCKED → PAUSED로 풀고, `REQUESTS_RECOVERY`가 참인 잡에는 복구 트리거(그룹 `RECOVERING_JOBS`, 이름 `recover_<인스턴스>_<번호>`, MISFIRE_INSTR -1)를 넣습니다. 그 뒤 그 노드의 `FIRED_TRIGGERS` 행을 지우고, 실행 기록이 남지 않은 COMPLETE 트리거를 지우고, **그 노드의 `SCHEDULER_STATE` 행을 DELETE**합니다.
    - 같은 인스턴스 ID로 재시작한 노드는 첫 체크인에서 자기 기록을 스스로 복구하고 행을 지우지 않고 갱신합니다. 첫 체크인 때는 `SCHEDULER_STATE` 행 없이 `FIRED_TRIGGERS`만 남은 인스턴스(고아 기록)도 복구합니다(`findOrphanedFailedInstances`).
    - 살아남은 노드가 없으면 행은 지워지지 않고 체크인 시각만 멈춥니다. 이때는 `CLUSTER_DOWN`이 잡힙니다.
- **연체 판정**: 정상 클러스터에서는 각 노드의 MisfireHandler가 `misfireThreshold`(기본 60초) 간격으로 misfire된 WAITING 트리거의 NEXT_FIRE_TIME을 갱신합니다(§7.4). 따라서 연체 상태가 이어진다는 것은 클러스터가 트리거를 처리하지 못한다는 뜻입니다(노드 다운, 스레드 풀 고갈 등). "misfire가 처리되어 실행을 건너뛴 경우"는 DB에 흔적이 남지 않아 MVP에서 감지하지 못합니다. 스냅샷 비교 방식은 Phase 2에서 검토합니다.
  - 트리거는 `misfireThreshold`가 지나야 misfire가 되고, MisfireHandler가 처리하기까지 최대 한 주기(`misfireThreshold`)가 더 걸립니다. 그래서 `overdue_grace_ms`는 `misfire_threshold_ms` 이상이어야 정상 클러스터에서 오탐이 나지 않습니다. 기본값(둘 다 60000)은 이 조건을 겨우 만족하므로, 스케줄러 설정에서 `misfire_threshold_ms`를 바꾸면 `overdue_grace_ms`의 기본값도 같은 값으로 맞춥니다.
  - 도구가 재개한 트리거는 MisfireHandler가 처리할 때까지 지난 NEXT_FIRE_TIME을 가진 WAITING으로 남으므로 연체로 보일 수 있습니다. 감사 로그에서 `misfire_threshold_ms + overdue_grace_ms` 안에 도구가 재개한 트리거는 `OVERDUE` 판정에서 뺍니다.
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

- 기록 지점: 제어 명령(§7.1 절차), 접속·스케줄러·규칙·채널·사용자 변경, 로그인 성공과 실패, 로그아웃(유효한 세션을 끝낸 경우), 비밀번호 변경·초기화(값은 남기지 않고 `{ passwordChanged: true }`만)
  - 초기 관리자 생성은 작업자 없는 시스템 작업(`user_id`, `username` 모두 null)으로 남기고 `reason`에 사유를 적습니다.
  - 로그인 실패는 입력한 아이디를 `username`에 남기고, 그 아이디가 있으면 `user_id`도 채웁니다.
  - 남기지 않는 요청: 속도 제한(429)에 걸린 로그인(기록이 끝없이 쌓이지 않게), 요청 형식 검증(400)에서 막힌 요청
- 기록 방식(`AuditService`)
  - 시간이 걸리거나 대상을 바꾸는 작업은 `begin`/`run`으로 `pending`을 먼저 남기고, 끝나면 `success` 또는 `failure`로 바꿉니다. `pending`을 남기지 못하면 작업도 하지 않습니다. 결과는 `pending`인 행만 한 번 바꿀 수 있습니다.
  - 바로 끝나는 이벤트(로그인, 로그아웃)는 `success`/`failure`로 한 번에 남깁니다. 실패 기록 자체가 실패하면 원래 오류를 가리지 않도록 서버 로그만 남깁니다.
  - 기동 시 `pending`으로 남은 기록은 `failure`(`error_code=INTERRUPTED`)로 정리합니다.
  - `error_code`, `error_message`는 `ApiError`의 코드와 한국어 메시지입니다. 처리하지 못한 예외는 내부 메시지 대신 `INTERNAL_ERROR`와 고정 문구를 남깁니다(드라이버 메시지에 접속 정보가 섞일 수 있음).
  - 작업 종류(`action`)와 대상 종류(`target_type`)는 `@qa/shared`의 `AUDIT_ACTIONS`, `AUDIT_TARGET_TYPES`에 모읍니다. 기능을 추가하는 작업이 여기에 이어 붙입니다.
- 마스킹: `target`, `before`, `after`를 저장하기 직전에 `maskSecrets`를 통과시킵니다.
  - 키 이름이 password, passphrase, secret, token, api key, credential, private key, authorization, cookie, webhook을 포함하거나 `Enc`/`_enc`로 끝나면 값을 `***`로 바꿉니다. 값이 불리언이나 null이면 사실 기록을 위해 그대로 둡니다.
  - 문자열 안의 URL 자격증명(`scheme://user:pass@host`)의 비밀번호 부분도 가립니다.
- 앱 코드에는 `audit_logs`를 수정하는 경로가 없습니다(INSERT와 `pending` 결과 갱신만 존재). 정리는 보존 정책 작업(`audit_logs`, §3.3)만 합니다. 테스트가 소스 전체에서 `audit_logs`를 바꾸는 코드가 `AuditService` 밖에 없는지 확인합니다.
- `GET /audit-logs`: 로그인한 사용자 누구나 조회합니다(PRD 권한 모델).
  - 필터: `from`(포함)·`to`(제외, epoch ms), `userId`, `username`, `schedulerId`, `action`, `result`
  - 페이지: 최신순(id 내림차순). `limit`(기본 50, 최대 200)과 이전 응답의 `nextCursor`를 `cursor`로 넘기는 키셋 방식입니다. 응답은 `{ items, nextCursor }`이고 `nextCursor`가 null이면 마지막 페이지입니다.
- `GET /audit-logs/:id`: 기록 하나(상세 화면 `/audit-log?id=N`용). 없으면 404 `NOT_FOUND`
- `GET /audit-logs/export.csv`(P1, 스트리밍, B-34)

## 11. 배포와 운영

### 11.1 컨테이너

- 멀티 스테이지 빌드(`docker/Dockerfile`): `pnpm fetch`(잠금 파일만으로 의존성 레이어 캐시) → `pnpm install --offline` → `turbo run build --filter=@qa/api`(웹 export 후 API 빌드와 `public/` 복사) → `pnpm deploy --prod --legacy`로 운영 의존성과 `@qa/api`의 `files`(`dist`, `drizzle`, `public`)만 모아 `node:24-bookworm-slim` 실행 이미지로 옮깁니다. better-sqlite3 소스 빌드에 대비해 빌드 단계에만 `python3`, `make`, `g++`를 둡니다.
- 실행 이미지의 앱 파일은 root 소유이고, 비루트 사용자(`node`)로 실행합니다. `/data`(권한 700)만 쓸 수 있고, DB와 백업 파일은 600입니다(NFR-SEC-05).
- `docker/compose.yaml`: 서비스 하나, 이름 있는 볼륨 하나(`qa-data:/data`), `read_only: true`(루트 파일시스템 읽기 전용), 메모리 `/tmp`(tmpfs 64MB, SQLite 임시 파일용), `cap_drop: ALL`, `no-new-privileges`. 환경변수는 `docker/.env`(`QA_ENV_FILE`로 바꿀 수 있음)에서 받습니다.
- 헬스체크(로그인 불필요, `/api/v1` 밖): `GET /healthz`(프로세스), `GET /readyz`(SQLite 응답, 마이그레이션 기록 존재). `/readyz`가 실패하면 503과 항목별 결과(`checks`)를 주고, 내부 오류 메시지는 넣지 않습니다. 이미지 `HEALTHCHECK`는 `node`로 `/readyz`를 부릅니다(slim 이미지에 curl 없음).
- `docker/smoke.sh`가 이미지 빌드, compose 기동, 같은 포트의 화면·API, 비루트 실행과 `/data` 밖 쓰기 실패, 재시작 후 데이터 유지, JSON 로그를 확인합니다. CI `container` 잡에서 PR마다 실행합니다.

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

- 검증은 `apps/api/src/config/env.ts`(zod)가 기동 시 한 번 합니다. 결과 `AppConfig`는 DI(`APP_CONFIG`)로만 전달하고, 모듈은 `process.env`를 직접 읽지 않습니다.
- 잘못된 값은 변수별 원인을 모아 한 번에 출력하고 종료합니다(exit 1, 스택 트레이스 없음). 메시지에 키 값은 넣지 않습니다.
- 빈 문자열은 지정하지 않은 것으로 봅니다. `QA_ADMIN_USERNAME`과 `QA_ADMIN_PASSWORD`는 함께 지정해야 하고, 화면에서 만드는 계정과 같은 아이디·비밀번호 규칙(§4.2)을 따릅니다. `QA_SMTP_*`를 하나라도 쓰면 `QA_SMTP_HOST`와 `QA_SMTP_FROM`이 필요합니다(포트 기본값 587).
- `start`, `dev`, `cli` 스크립트는 `node --env-file-if-exists=.env`로 실행합니다. 로컬 개발에서는 `apps/api/.env`를 쓰고(`.env.example` 참고), 이미 설정된 환경변수가 우선합니다.
- `cli backup`은 암호화 키 없이 `QA_DATA_DIR`만 읽습니다.

### 11.3 로깅

- nestjs-pino(pino-http)로 Nest 로그와 접근 로그를 모두 표준 출력에 JSON 한 줄씩 남깁니다(`apps/api/src/logging/http-logger.ts`). 시각은 ISO 문자열, 레벨은 문자열(`info`)이고, Nest 로그의 클래스 이름은 `context`입니다.
- 접근 로그 한 줄: `requestId`(요청 ID 미들웨어 값, §2.3), `userId`(로그인한 요청), `req.method`, `req.url`(쿼리 문자열 제외), `res.statusCode`, `durationMs`. 요청·응답 헤더와 본문은 남기지 않습니다. 5xx는 `error`, 나머지는 `info`이고, 헬스체크 요청은 남기지 않습니다.
- 제어 명령과 감시 루프는 해당 작업에서 `schedulerId`, `command`를 더합니다.
- `password`, `currentPassword`, `newPassword`, `passwordEnc`, `password_enc`, `configEnc`, `config_enc`, `authorization`, `cookie` 키(최상위와 한 단계 아래)는 `***`로 마스킹합니다. 드라이버 오류 메시지는 접속 문자열을 지운 뒤 기록합니다(NFR-SEC-03, B-11).
- Nest가 뜨기 전 기동 실패(설정 오류, 인스턴스 중복)도 같은 형식으로 남깁니다(`level: fatal`).
- nestjs-pino는 프로세스마다 pino-http 인스턴스를 하나만 만듭니다. 테스트는 앱마다 출력 대상을 바꾸지 않고 공유 객체(`testLogs`)를 비워 씁니다.

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
- S1 결과로 정한 차등 테스트용 기능(부록 A.1). B-09에는 없고 B-17에서 추가합니다(지금 노드는 기동하면 항상 `start()`합니다):
  - **기준 인스턴스**: `start()`하지 않은 Quartz 인스턴스로 명령을 실행합니다. 획득, MisfireHandler, ClusterManager가 돌지 않으므로 결과 행이 결정적입니다. misfire 케이스(부록 A.3의 R-2x)만 `start()`한 인스턴스로 실행하고 수렴한 뒤 비교합니다.
  - **픽스처 SQL**: ACQUIRED, ERROR, COMPLETE 상태와 `FIRED_TRIGGERS` 행(ACQUIRED, EXECUTING)처럼 API로 만들 수 없는 초기 상태를 직접 SQL로 만듭니다.
  - **잠금 점유**: `TRIGGER_ACCESS` 행을 N초 동안 잡고 있는 엔드포인트(`LOCK_TIMEOUT` 검증용)
  - **행 스냅샷**: SCHED_NAME 하나의 `TRIGGERS`, 하위 4개 테이블, `PAUSED_TRIGGER_GRPS`, `JOB_DETAILS`(키, IS_DURABLE), `FIRED_TRIGGERS`를 정렬된 JSON으로 내보냅니다.
- 스키마 초기화는 Quartz 배포본의 `tables_*.sql`을 씁니다(`tools/quartz-testbed/schema/`에 2.5.2 jar의 파일을 그대로 둠). 헬퍼가 CREATE 문만 골라 prefix와 대소문자를 바꿉니다. 테이블뿐 아니라 제약 조건과 인덱스 이름의 prefix도 바꾸므로 한 스키마에 prefix 여러 개를 둘 수 있습니다. 변형 시나리오로 사용자 지정 prefix, 대문자와 소문자 테이블명, Oracle 23 `BOOLEAN` 스키마(`tables_oracle23.sql`), MySQL `lower_case_table_names=1`(B-28), 한 DB 안의 여러 SCHED_NAME을 둡니다.
  - Quartz는 테이블명을 따옴표 없이 쓰므로 Oracle의 소문자(따옴표) 테이블에는 Quartz 노드를 붙일 수 없습니다. 이 변형은 자동 감지 테스트에만 씁니다.
- `core-vectors` 서브커맨드가 §6.2의 벡터(cron, 트리거, 타임존, properties)를 만듭니다. `cron-vectors` 서브커맨드는 cron만 만듭니다. 입력은 (cron, 타임존, 기준 시각 목록), 출력은 조합마다 다음 실행 시각 20개(epoch ms와 해당 타임존 ISO-8601)입니다. 잘못된 표현식은 Quartz 오류 메시지를, 모르는 타임존은 Java가 실제로 쓴 ID(`GMT`)를 함께 남깁니다.

통합 테스트 헬퍼는 `packages/store/test/support/`에 있고 `pnpm test:integration`(Docker 필요)으로 돕니다. 단위 테스트(`pnpm test`)와는 분리돼 있습니다.

화면이나 API를 손으로 확인할 때는 `pnpm --filter @qa/store testbed:up`으로 Oracle Free 23과 2노드 클러스터(잡 2개)를 띄웁니다. 접속 정보는 `packages/store/.testbed.json`에 쓰이고, 같은 위치에 `.testbed.stop` 파일을 만들거나 `QA_TESTBED_MINUTES`(기본 120)분이 지나면 끝납니다(두 파일은 git 제외 대상). CI에서는 돌리지 않습니다.

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
- MVP 기능 개발 동안은 PR에서 CI를 돌리지 않습니다. 워크플로는 main 푸시와 수동 실행(`workflow_dispatch`)에만 돌고, main 브랜치 보호의 필수 검사(`verify`)도 해제했습니다. PR을 올리기 전에는 로컬에서 `pnpm format:check`, `build`, `lint`, `typecheck`, `test`(대상 DB 코드를 바꿨으면 `test:integration`도)를 돌립니다. MVP 이후 CI/CD를 정리할 때 PR 트리거와 필수 검사를 다시 켭니다.

### 12.3 구현 전 확인 항목 (스파이크)

| ID | 내용 | 결과물 |
| --- | --- | --- |
| S1 | Quartz 2.3.2 `JobStoreSupport`, `StdJDBCDelegate`, `StdRowLockSemaphore`를 읽고 §7.2와 §7.3의 상태 전이, 잠금, `rescheduleJob` 동작을 확인 | **완료**(B-08). §5.4, §7.1~7.6, §9.2, 부록 A에 반영. 2.5.2도 같은 동작 |
| S2 | quartz-testbed와 Testcontainers 4종 DB 골격. 2노드 클러스터 기동 확인 | **완료**(B-09, Oracle). `tools/quartz-testbed`, `packages/store/test/support/`, §12.1. 나머지 3종 DB는 B-27~B-29 |
| S3 | `oracledb` Thin 모드로 Oracle XE 21과 Free 23에 접속하고 BLOB과 NUMBER 매핑 확인 | **완료**(B-11, Free 23). `@qa/store` 어댑터·풀·`QuartzDialect`, §5.2·§5.3·§5.6에 반영(배열 바인드 순서, Thin `callTimeout` 한계, Oracle 23 잠금 오류 코드). XE 21은 amd64 전용이라 CI 매트릭스(B-30)에서 확인 |
| S4 | `CronExpression` 이식 범위와 Luxon으로 Java Calendar의 DST 처리(존재하지 않는 시각, 중복 시각)를 재현할 수 있는지 확인 | 벡터 50개 통과 프로토타입 |

## 13. PRD 변경 제안

TRD를 쓰면서 Quartz 동작 방식 때문에 PRD를 조정해야 하는 항목입니다. 2026-11-05에 1~6번이 승인되어 PRD v0.3에 반영했습니다. 7~8번은 스파이크 S1(B-08)에서 소스를 확인한 결과이며 PRD v0.5에 반영했습니다.

| # | 대상 | 제안 | 이유 |
| --- | --- | --- | --- |
| 1 | FR-CTL-04 | "도구가 다시 계산한다"를 "재개 후 Quartz 노드가 misfire 정책에 따라 처리한다(도구는 상태만 전이)"로 변경 | 결과는 같고, misfire 처리 방식과 캘린더를 이식하지 않아도 됨(§7.4) |
| 2 | FR-CTL-06/07 | 캘린더가 연결된 트리거는 스케줄 수정 대상에서 제외 | 캘린더는 Java 직렬화 BLOB이라 제외 시간을 계산할 수 없음 |
| 3 | FR-CTL-12 | 고아 `FIRED_TRIGGERS` 정리를 MVP에서 빼고, "오래된 실행 기록 표시"로 대체 | Quartz ClusterManager가 죽은 노드의 실행 기록을 복구(복구 요청 잡 재실행, BLOCKED 해제)하며 정리함. 수동 삭제는 이 복구를 건너뜀 |
| 4 | FR-ALT-04 | 노드 이탈 판정 기준을 "체크인 시각"에서 "활성 노드 수 < 기대 노드 수"로 변경(기대 노드 수는 설정값) | 살아남은 노드가 죽은 노드의 행을 곧바로 삭제하고, AUTO 인스턴스 ID는 재시작마다 바뀜(§9.2) |
| 5 | FR-CTL-00d | 스케줄 수정 시 개별 일시정지 상태를 유지하는 것을 Quartz와의 의도된 차이로 명시 | Quartz `rescheduleJob`은 일시정지를 해제함 |
| 6 | NFR-REL-04 | 다중 인스턴스를 감지하면 "경고"가 아니라 "기동 거부" | SQLite 파일 하나를 두 프로세스가 쓰면 감시와 발송이 중복됨 |
| 7 | FR-CTL-04 | 재개 후 misfire 반영은 "즉시"가 아니라 "최대 misfireThreshold(기본 60초) 안"임을 명시. 일시정지된 그룹 안의 트리거를 개별 재개할 때 실행 시각이 지났으면 거부 | Quartz `resumeTrigger`는 같은 트랜잭션에서 misfire를 처리하지만 MisfireHandler는 주기적으로 돌고, 그룹 일시정지를 다시 적용함(§7.4) |
| 8 | FR-CTL-00d | 그룹 단위 명령의 그룹 이름을 정확히 일치로 비교하는 것을 의도된 차이로 명시 | Quartz는 그룹 일시정지와 재개에서 그룹 이름을 이스케이프 없는 `LIKE`로 비교해 `_`, `%`가 든 이름이 다른 그룹과 겹칠 수 있음(§7.3) |

## 부록 A. 상태 전이 테스트 케이스

B-17~B-21의 통합 테스트와 차등 테스트가 이 목록을 씁니다. 각 케이스는 4종 DB와 Quartz 2.3.2/2.5.x 매트릭스에서 같은 기대 결과를 가져야 합니다. 근거 약칭은 문서 앞머리를 따릅니다.

### A.1 공통 규칙

- **표기**: 상태는 `W`=WAITING, `A`=ACQUIRED, `B`=BLOCKED, `P`=PAUSED, `PB`=PAUSED_BLOCKED, `E`=ERROR, `C`=COMPLETE로 줄여 씁니다. `PTG`=`PAUSED_TRIGGER_GRPS`, `ALL`=`_$_ALL_GROUPS_PAUSED_$_` 행, `FT`=`FIRED_TRIGGERS`, `NFT`=NEXT_FIRE_TIME입니다.
- **잡 종류**: `J`=일반 잡(동시 실행 허용, durable), `JN`=`@DisallowConcurrentExecution` 잡, `JV`=durable이 아닌 잡.
- **"실행 중"**: 같은 잡의 `FT` 행이 `ENTRY_STATE='EXECUTING'`이고 `JOB_NAME`, `JOB_GROUP`이 채워진 상태. `FT(ACQ)`는 획득만 된 행(`JOB_NAME` NULL).
- **비교 방식**
  - `차등`: 같은 초기 상태에서 기준 인스턴스(§12.1, `start()`하지 않음)로 Quartz API를 실행한 결과와 도구 결과의 행 스냅샷이 같아야 합니다. 비교에서 빼는 컬럼은 케이스에 적습니다.
  - `수렴`: `start()`한 클러스터에서 실행하고, 지정한 조건이 될 때까지(최대 `misfireThreshold × 2`) 기다린 뒤 비교합니다.
  - `도구`: Quartz와 일부러 다르거나(Δ) 도구만 거부하는 경우. 기대 결과만 확인합니다.
  - `통합`: 2노드 클러스터에서 실제 발화 여부(`TESTBED_EXECUTIONS`)를 확인합니다.
- **공통 사후 조건**: 모든 케이스에서 명령이 끝나면 `LOCKS`의 `TRIGGER_ACCESS` 행 잠금이 풀려 있어야 하고, 실패한 명령은 대상 DB의 행을 하나도 바꾸지 않아야 합니다.

### A.2 일시정지 (`pauseTrigger`, `pauseJob`) — 근거 `JSS.pauseTrigger`

| ID | 초기 상태 | 명령 | 기대 결과 | 비교 |
| --- | --- | --- | --- | --- |
| P-01 | T1(J) `W` | pauseTrigger T1 | T1 `P`. NFT 그대로. `PTG` 변화 없음 | 차등 |
| P-02 | T1(J) `A`, `FT(ACQ)` 있음 | pauseTrigger T1 | T1 `P`. `FT` 행은 그대로(노드가 해제할 때 지움) | 차등 |
| P-03 | T1(JN) `B`, JN 실행 중 | pauseTrigger T1 | T1 `PB` | 차등 |
| P-04 | T1 `P` / `PB` / `E` / `C` 각각 | pauseTrigger T1 | 변화 없음. 도구는 "변경 없음"으로 응답 | 차등 |
| P-05 | J에 T1 `W`, T2 `B`(JN일 때), T3 `P`, T4 `E` | pauseJob | T1 `P`, T2 `PB`, T3 `P`, T4 `E` | 차등 |
| P-06 | T1(J) 다음 발화 2초 전(`A`가 됨) | pauseTrigger T1 | 발화하지 않음. 노드의 `releaseAcquiredTrigger` 뒤 T1 `P` 유지, `FT` 행 삭제 | 통합 |
| P-07 | P-06을 200회 반복(발화 시각 직전 무작위 시점) | pauseTrigger T1 | 커밋 이후 시각의 실행 기록 0건 | 통합 |

### A.3 재개 (`resumeTrigger`, `resumeJob`) — 근거 `JSS.resumeTrigger`, `JSS.checkBlockedState`, `JSS.recoverMisfiredJobs`

| ID | 초기 상태 | 명령 | 기대 결과 | 비교 |
| --- | --- | --- | --- | --- |
| R-01 | T1(J) `P`, NFT 미래 | resumeTrigger T1 | T1 `W`, NFT 그대로 | 차등 |
| R-02 | T1(JN) `P`, JN 실행 중(`FT` EXECUTING, IS_NONCONCURRENT 참) | resumeTrigger T1 | T1 `B` | 차등 |
| R-03 | T1(JN) `PB`, JN 실행 중 | resumeTrigger T1 | T1 `B` | 차등 |
| R-04 | T1(JN) `PB`, `FT` 행 없음 | resumeTrigger T1 | T1 `W` (PB라도 실행 중이 아니면 W) | 차등 |
| R-05 | T1(J) `P`, J 실행 중(`FT` IS_NONCONCURRENT 거짓) | resumeTrigger T1 | T1 `W` | 차등 |
| R-06 | T1(JN) `P`, 같은 잡 T2의 `FT(ACQ)`만 있음 | resumeTrigger T1 | T1 `W` (ACQUIRED 행은 판정에 안 쓰임) | 차등 |
| R-07 | T1 `W` / `B` / `E` / `C` 각각 | resumeTrigger T1 | 변화 없음 | 차등 |
| R-08 | T1 `P`, NFT가 `-1` 또는 NULL | resumeTrigger T1 | 변화 없음(T1 `P` 유지) | 차등 |
| R-09 | T1 `P`, 그룹 G가 `PTG`에 있음, NFT 미래 | resumeTrigger T1 | T1 `W`, `PTG`의 G 행 유지 | 차등 |
| R-10 | J에 T1 `P`, T2 `PB`(JN 실행 중), T3 `E` | resumeJob | T1 `W`(JN이면 `B`), T2 `B`, T3 `E` | 차등 |
| R-11 | T1 `P`, NFT가 dbNow − 10초(임계값 안) | resumeTrigger T1 | T1 `W`, NFT 그대로. 곧 발화 | 차등 + 통합 |
| R-21 | CRON T1 `P`, MISFIRE_INSTR 0 또는 1(FIRE_ONCE_NOW), NFT가 dbNow − 5분 | resumeTrigger T1 | 도구 직후: T1 `W`, NFT 옛 값. 수렴 후: 한 번 실행되고 NFT가 Quartz 결과와 같음 | 수렴(조건: NFT ≥ dbNow − 임계값) |
| R-22 | R-21과 같되 MISFIRE_INSTR 2(DO_NOTHING) | resumeTrigger T1 | 수렴 후: 실행 없음, NFT = 지금 이후 첫 cron 시각 | 수렴 |
| R-23 | SIMPLE T1 `P`, 무한 반복 10초 간격, MISFIRE_INSTR 각각 0~5, NFT가 dbNow − 5분 | resumeTrigger T1 | 수렴 후 NFT, TIMES_TRIGGERED, REPEAT_COUNT가 Quartz 결과와 같음 | 수렴 |
| R-24 | SIMPLE T1 `P`, MISFIRE_INSTR −1(IGNORE), 10초 간격, NFT가 dbNow − 60초 | resumeTrigger T1 | MisfireHandler를 거치지 않고 곧바로 획득되어 놓친 실행을 연속으로 따라잡음. Quartz와 실행 횟수 같음 | 수렴 + 통합 |
| R-25 | SIMPLE T1 `P`, 10초 간격, REPEAT_COUNT 2, TIMES_TRIGGERED 1, MISFIRE_INSTR 4(RESCHEDULE_NEXT_WITH_REMAINING_COUNT), NFT가 dbNow − 5분 | resumeTrigger T1 | 수렴 후 T1 `C`, NFT 없음(마지막 실행 시각이 지나 더 발화하지 않음). 클러스터 모드에서는 행이 삭제되지 않고 남음(Quartz와 같음) | 수렴 |
| R-26 | CRON T1(JN) `P`, JN 실행 중(30초 잡), NFT가 dbNow − 5분 | resumeTrigger T1 | 도구 직후 T1 `B`, NFT 옛 값. 잡이 끝나 `W`가 된 뒤 수렴 후 Quartz 결과와 같음 | 수렴 |
| R-31 | T1 `P`, 그룹 G가 `PTG`에 있음, NFT 과거 | resumeTrigger T1 | 409 `RESUME_IN_PAUSED_GROUP`, 변화 없음 (Δ: Quartz는 `W`로 바꾸고 바로 misfire 처리) | 도구 |
| R-32 | T1 `P`, `ALL`만 있음(G 행 없음), NFT 과거 | resumeTrigger T1 | 409 `RESUME_IN_PAUSED_GROUP`, 변화 없음 | 도구 |
| R-33 | 잡 J의 T1이 R-31 조건, T2는 정상 `P` | resumeJob J | 409, T1·T2 모두 변화 없음. 미리보기에 T1 표시 | 도구 |

### A.4 그룹과 전체 (`pause/resumeTriggerGroup`, `pause/resumeJobGroup`, `pauseAll`/`resumeAll`) — 근거 `JSS.pauseTriggerGroup`, `JSS.resumeTriggerGroup`, `JSS.pauseJobs`, `JSS.pauseAll`, `JSS.resumeAll`, `JSS.storeTrigger`

| ID | 초기 상태 | 명령 | 기대 결과 | 비교 |
| --- | --- | --- | --- | --- |
| G-01 | 그룹 G에 `W`, `A`, `B`, `P`, `PB`, `E`, `C` 트리거 각 1개 | pauseTriggerGroup G | `P`, `P`, `PB`, `P`, `PB`, `E`, `C`. `PTG`에 G 행 1개 | 차등 |
| G-02 | 트리거가 없는 그룹 G | pauseTriggerGroup G | `PTG`에 G 행 INSERT | 차등 |
| G-03 | G가 이미 `PTG`에 있음 | pauseTriggerGroup G | `PTG`의 G 행 1개(중복 없음) | 차등 |
| G-04 | G-01 뒤 | 테스트베드로 G에 새 트리거 `scheduleJob` | 새 트리거 `P` (일시정지된 그룹은 이후 추가 트리거에도 적용) | 통합 |
| G-05 | G-01 결과 상태 | resumeTriggerGroup G | `PTG`의 G 행 삭제. 각 트리거에 A.3 규칙(`P`→`W`, `PB`→`B`/`W`), `E`·`C` 그대로 | 차등 |
| G-06 | G가 `PTG`에 없음. G의 T1만 개별로 `P` | resumeTriggerGroup G | T1 `W` (그룹 재개는 개별 일시정지도 풂) | 차등 |
| G-07 | 그룹 `A_B`와 `AXB`가 모두 있고 각자 `W` 트리거 보유 | pauseTriggerGroup `A_B` | `A_B`의 트리거만 `P`, `PTG`에 `A_B`만 (Δ: Quartz는 `AXB`도 일시정지하고 `PTG`에 둘 다 넣음) | 도구 |
| G-08 | 잡 그룹 JG에 잡 2개, 각 트리거 `W` | pauseJobGroup JG | 모든 트리거 `P`. `PTG` 변화 없음 | 차등 |
| G-09 | G-08 뒤 | 테스트베드로 JG에 새 잡과 트리거 추가 | 새 트리거 `W` (잡 그룹 일시정지는 저장되지 않음) | 통합 |
| G-10 | G-08 결과 상태 | resumeJobGroup JG | 모든 트리거 `W` | 차등 |
| G-11 (P1) | 그룹 G1(`W`), G2(`B`, JN 실행 중), `PTG`에 트리거 없는 그룹 G9 | pauseAll | G1 `P`, G2 `PB`. `PTG`에 G1, G2, G9, `ALL` | 차등 |
| G-12 (P1) | G-11 뒤 | 테스트베드로 새 그룹 G3에 트리거 추가 | 새 트리거 `P`, `PTG`에 G3 행 추가 | 통합 |
| G-13 (P1) | G-11 결과 상태 | resumeAll | G1 `W`, G2 `B`. `PTG`의 G1, G2, `ALL` 삭제, **G9 행은 남음** | 차등 |

### A.5 즉시 실행 (`triggerJob`) — 근거 `QS.triggerJob`, `Delegate.insertTrigger`, `JSS.storeTrigger`, `JSS.triggeredJobComplete`

비교에서 TRIGGER_NAME, START_TIME, NEXT_FIRE_TIME, DESCRIPTION을 뺍니다.

| ID | 초기 상태 | 명령 | 기대 결과 | 비교 |
| --- | --- | --- | --- | --- |
| T-01 | 잡 J, 일시정지 없음 | triggerJob J | 새 TRIGGERS 행: 그룹 `DEFAULT`, 이름 `MT_`로 시작, TYPE `SIMPLE`, 상태 `W`, PREV −1, END 0, PRIORITY 5, MISFIRE_INSTR 0, JOB_DATA NULL, CALENDAR NULL. SIMPLE_TRIGGERS (0, 0, 0). START_TIME = NFT ≈ dbNow | 차등 |
| T-02 | `PTG`에 `DEFAULT` | triggerJob J | 상태 `P`. `PTG` 변화 없음 | 차등 |
| T-03 | `PTG`에 `ALL`만 | triggerJob J | 상태 `P`. `PTG`에 `DEFAULT` 행 INSERT | 차등 |
| T-04 | JN 실행 중 | triggerJob JN | 상태 `B` | 차등 |
| T-05 | JN 실행 중, `PTG`에 `DEFAULT` | triggerJob JN | 상태 `PB` | 차등 |
| T-06 | J 실행 중(동시 실행 허용) | triggerJob J | 상태 `W` | 차등 |
| T-07 | 잡이 없음 | triggerJob X | 404, 행 변화 없음 | 도구 |
| T-08 | 2노드 클러스터, 잡 J | triggerJob J | 정확히 1회 실행. 실행이 끝나면 새 트리거의 TRIGGERS·SIMPLE_TRIGGERS·`FT` 행이 모두 사라짐 | 통합 |
| T-09 | T-08 실행 도중 실행 노드를 강제 종료 | — | 살아남은 노드의 복구 뒤 새 트리거(`C`) 행이 사라짐 | 통합 |

### A.6 스케줄 수정 (`updateCronSchedule`, `updateSimpleSchedule`) — 근거 `QS.rescheduleJob`, `JSS.replaceTrigger`, `JSS.triggerFired`

차등 비교의 Quartz 기준 호출은 §7.6의 "Quartz 대응"입니다. 비교에서 PREV_FIRE_TIME과(CRON이면) START_TIME을 빼고, NEXT_FIRE_TIME은 같은 기준 시각으로 계산한 값끼리 비교합니다.

| ID | 초기 상태 | 명령 | 기대 결과 | 비교 |
| --- | --- | --- | --- | --- |
| C-01 | CRON T1 `W` | updateCron T1 새 식, 새 TZ | 식·TZ 변경, NFT = `getFireTimeAfter(max(dbNow, START−1000))`, 상태 `W`. 다른 컬럼 그대로 | 차등 |
| C-02 | CRON T1 `P` | updateCron T1 | 상태 `P` 유지 (Δ: Quartz는 `W`) | 도구 |
| C-03 | CRON T1(JN) `PB`, JN 실행 중 / 실행 아님 | updateCron T1 | 각각 `PB` / `P` (Δ) | 도구 |
| C-04 | CRON T1(JN) `B`, JN 실행 중 | updateCron T1 | 상태 `B` | 차등 |
| C-05 | CRON T1 `A` (발화 10초 전에 획득됨) | updateCron T1 (첫 실행이 1분 뒤인 식) | 상태 `W`. 옛 시각에 발화하지 않음. 이후 새 식의 시각에 발화하고 NFT가 옛 식으로 되돌아가지 않음 | 차등 + 통합 |
| C-06 | CRON T1 `E` | updateCron T1 | 상태 `W` (Quartz와 같음, 미리보기 경고) | 차등 |
| C-07 | CRON T1 `W`인데 그룹 G가 `PTG`에 있음(개별 재개 후) | updateCron T1 | 상태 `P` | 차등 |
| C-08 | CRON T1 `W`, `PTG`에 `ALL`만 | updateCron T1 | 상태 `P`, `PTG`에 G 행 INSERT | 차등 |
| C-09 | CRON T1 `C` | updateCron T1 | 409, 변화 없음 (Δ: Quartz는 `W`로 다시 넣음) | 도구 |
| C-10 | CRON T1에 CALENDAR_NAME 있음 | updateCron T1 | 409, 변화 없음 | 도구 |
| C-11 | CRON T1, END_TIME이 지남 | updateCron T1 | 400(더 이상 발화하지 않음), 변화 없음 | 차등(Quartz도 예외) |
| C-12 | CRON T1, START_TIME이 1시간 뒤 | updateCron T1 | NFT ≥ START_TIME | 차등 |
| C-13 | 2노드 클러스터, CRON T1 `W` | updateCron T1 `*/10 * * * * ?` | 실제 발화 시각이 미리보기 5개와 같음 | 통합 |
| S-01 | SIMPLE T1 `W`, TIMES_TRIGGERED 7 | updateSimple T1 간격 5초, 횟수 3 | INTERVAL 5000, COUNT 3, TIMES 0, START = NFT ≈ dbNow, 상태 `W` | 차등 |
| S-02 | SIMPLE T1 `W` | updateSimple startAt = dbNow + 1시간 | START = NFT = startAt | 차등 |
| S-03 | SIMPLE T1 | startAt = dbNow − 1분 | 400, 변화 없음 | 도구 |
| S-04 | SIMPLE T1 | 횟수 3, 간격 0 | 400, 변화 없음 (Quartz `validate`도 거부) | 차등 |
| S-05 | SIMPLE T1, END_TIME = dbNow + 1분 | startAt = dbNow + 2분 | 400, 변화 없음 | 차등 |
| S-06 | SIMPLE T1 `P` | updateSimple T1 | 상태 `P` 유지 (Δ) | 도구 |
| S-07 | SIMPLE T1 `A` | updateSimple T1 | 상태 `W` (C-05와 같은 이유) | 차등 + 통합 |

### A.7 삭제 (`deleteTrigger`, `deleteJob`) — 근거 `JSS.removeTrigger`, `JSS.removeJob`, `QS.deleteJob`, `JSS.triggeredJobComplete`

| ID | 초기 상태 | 명령 | 기대 결과 | 비교 |
| --- | --- | --- | --- | --- |
| D-01 | durable 잡 J의 유일한 CRON T1 | deleteTrigger T1 | TRIGGERS, CRON_TRIGGERS 행 삭제. JOB_DETAILS J 유지 | 차등 |
| D-02 | JV의 유일한 SIMPLE T1 | deleteTrigger T1 | T1과 하위 행 삭제, JOB_DETAILS JV도 삭제 | 차등 |
| D-03 | JV에 T1, T2 | deleteTrigger T1 | T1만 삭제, JV 유지 | 차등 |
| D-04 | 트리거 종류별(CRON, SIMPLE, CAL_INT→SIMPROP, 사용자 정의→BLOB) | deleteTrigger | 해당 하위 테이블 행과 TRIGGERS 행이 모두 삭제 | 차등 |
| D-05 | T1 `A`, `FT(ACQ)` 있음 | deleteTrigger T1 | T1 삭제. 노드가 발화하지 않고 `FT` 행을 지움 | 통합 |
| D-06 | T1으로 J 실행 중(`FT` EXECUTING) | deleteTrigger T1 | T1 삭제. 실행은 끝까지 진행되고 노드 로그에 오류 없음. 완료 후 `FT` 행 삭제 | 통합 |
| D-07 | 그룹 G가 `PTG`에 있음 | G의 마지막 트리거 deleteTrigger | `PTG`의 G 행 유지 | 차등 |
| DJ-01 | J에 CRON T1, SIMPLE T2 | deleteJob J | T1, T2, 하위 행, JOB_DETAILS 모두 삭제 | 차등 |
| DJ-02 | JN 실행 중, 다른 트리거 `B` | deleteJob JN | 모든 트리거와 잡 삭제. 실행은 오류 없이 끝나고 `FT` 행 삭제 | 통합 |
| DJ-03 | 트리거 없는 durable 잡 J | deleteJob J | JOB_DETAILS 삭제 | 차등 |

### A.8 잠금과 경합 (B-17) — 근거 `StdRowLockSemaphore`, `JSS.acquireNextTrigger`

| ID | 초기 상태 | 명령 | 기대 결과 | 비교 |
| --- | --- | --- | --- | --- |
| X-01 | 테스트베드가 `TRIGGER_ACCESS`를 10초 점유 | 아무 쓰기 명령 | 약 5초 후 `LOCK_TIMEOUT`, 행 변화 없음 | 도구 |
| X-02 | `LOCKS`에 `TRIGGER_ACCESS` 행 없음 | pauseTrigger T1 | 도구가 행을 INSERT하고 성공. 이후 Quartz 노드가 정상 동작 | 통합 |
| X-03 | 도구 트랜잭션 도중(잠금 확보 후) 프로세스 강제 종료 | — | 잠금이 풀리고 Quartz 노드가 계속 발화. 대상 행 변화 없음 | 통합 |
| X-04 | 화면에서 본 상태와 다름(expected `W`, 실제 `P`) | pauseTrigger T1 | 409 `STATE_CONFLICT`, 최신 상태 반환 | 도구 |
| X-05 | 그룹 G의 트리거 50개가 1초 간격으로 계속 발화하는 중 | pauseTriggerGroup G 20회 반복 | 매번 성공하거나 `TARGET_ERROR`(교착 롤백)이며, 실패한 회차는 행 변화 없음. 성공 뒤 G 트리거 발화 0건 | 통합 |
