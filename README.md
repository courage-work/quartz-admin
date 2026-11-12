# quartz-admin

여러 DB(Oracle, PostgreSQL, MySQL, MariaDB)에 흩어진 Quartz Scheduler 클러스터를 한 화면에서 조회하고 제어하는 사내 운영 도구입니다.

## 문서

| 문서                       | 내용                                                      |
| -------------------------- | --------------------------------------------------------- |
| [PRD](docs/PRD.md)         | 사용자, 범위, 기능·비기능 요구사항, 성공 지표             |
| [TRD](docs/TRD.md)         | 아키텍처, 저장소 스키마, 제어·감시 설계, 테스트           |
| [BACKLOG](docs/BACKLOG.md) | 마일스톤과 작업(B-xx), 진행 규칙, 요구사항 추적           |
| [DESIGN](docs/DESIGN.md)   | 디자인 시스템: 테마, 토큰, 상태 표시, 컴포넌트, 린트 규칙 |

## 개발 환경

- Node.js 24 (`.nvmrc`)
- pnpm 10 (`corepack enable`이면 `packageManager` 필드의 버전을 자동 사용)

```bash
pnpm install
pnpm build       # 전체 빌드 (turbo)
pnpm test        # 단위 테스트
pnpm test:integration  # 통합 테스트(Docker 필요, Oracle Free 23 + quartz-testbed)
pnpm --filter @qa/store testbed:up  # 손 확인용 Oracle + Quartz 2노드 클러스터(Docker 필요, 접속 정보: packages/store/.testbed.json)
pnpm lint        # ESLint (타입 기반 규칙, 웹 화면은 @shadcn/lint 디자인 규칙 포함)
pnpm typecheck   # TypeScript 검사
pnpm format      # Prettier 적용
```

개별 앱 실행:

```bash
pnpm --filter @qa/api dev   # NestJS, http://localhost:3000/api/v1 (데이터: apps/api/data/)
pnpm --filter @qa/web dev   # Next.js 개발 서버 http://localhost:3001. /design에서 디자인 시스템 확인
```

- 개발 중에는 브라우저로 `http://localhost:3001`에 접속합니다. 웹 개발 서버가 `/api` 요청을 API(`QA_API_URL`, 기본 `http://localhost:3000`)로 넘겨 화면과 API가 같은 오리진처럼 동작합니다. 이때 API의 `QA_PUBLIC_URL`은 `http://localhost:3001`로 둡니다(CSRF Origin 검사).
- `pnpm build`는 웹 정적 결과물(`apps/web/out`)을 `apps/api/public`으로 복사합니다. 빌드한 API(`pnpm --filter @qa/api start`)는 화면과 API를 한 포트에서 함께 서빙합니다. 웹을 빌드하지 않았으면 API만 제공합니다.

한 프로세스·한 포트로 개발하기(HMR):

```bash
pnpm dev:hmr   # http://localhost:3000 에서 화면과 API를 함께. 화면은 고치면 바로 반영(HMR), API는 고치면 다시 시작
```

- API 안에 Next 개발 서버를 붙여 `/api`와 헬스체크 밖의 요청을 넘깁니다(`QA_WEB_DEV=1`). 운영 서빙과 같은 오리진 구성을 개발 중에도 그대로 씁니다.
- `QA_PUBLIC_URL`은 `.env` 값과 상관없이 `http://localhost:<PORT>`(기본 3000)로 둡니다. 다른 주소를 쓰려면 셸에서 지정합니다.
- Next는 한 디렉터리에 개발 서버를 하나만 띄웁니다. `pnpm --filter @qa/web dev`와 동시에 쓸 수 없습니다.
- 화면 응답에는 helmet CSP를 붙이지 않습니다(HMR이 eval과 인라인 스크립트를 씀). 개발 전용이며 운영 이미지에는 웹 소스가 없어 켤 수 없습니다.
- API 코드를 고치면 프로세스가 다시 시작되면서 Next 개발 서버도 다시 뜹니다(몇 초 걸림).

API는 처음 실행하기 전에 `apps/api/.env`가 필요합니다. 암호화 키는 필수입니다.

```bash
cp apps/api/.env.example apps/api/.env
pnpm --filter @qa/api build
pnpm --filter @qa/api cli gen-key   # 출력값을 .env의 QA_ENCRYPTION_KEYS에 넣는다
```

환경변수 전체 목록은 [TRD §11.2](docs/TRD.md)에 있습니다. 값이 잘못되면 어떤 변수가 왜 틀렸는지 출력하고 기동하지 않습니다.

Windows에 Visual Studio C++ 빌드 도구가 없으면 `pnpm install`이 better-sqlite3의 `node-gyp` 단계에서 실패합니다. better-sqlite3에는 Windows용 사전 빌드 바이너리가 들어 있으므로 `pnpm install --ignore-scripts`로 설치하면 됩니다.

## Docker로 실행

운영 배포는 Docker Compose 한 서비스입니다(NFR-OPS-01). 화면과 API를 한 포트(3000)에서 서빙하고, 메타데이터는 이름 있는 볼륨 `qa-data`(`/data`)에 남습니다.

```bash
docker build -f docker/Dockerfile -t quartz-admin:local .
docker run --rm quartz-admin:local node dist/cli.js gen-key   # 출력값을 QA_ENCRYPTION_KEYS에 넣는다
cp docker/.env.example docker/.env                            # 값을 채운다
docker compose -f docker/compose.yaml up -d
```

- 비루트 사용자(`node`)로 실행하고 루트 파일시스템은 읽기 전용입니다. 쓰기는 `/data`와 메모리 `/tmp`만 됩니다.
- 헬스체크: `GET /healthz`(프로세스), `GET /readyz`(SQLite, 마이그레이션). 이미지의 `HEALTHCHECK`가 `/readyz`를 부릅니다.
- 로그는 표준 출력에 JSON 한 줄씩 남습니다(`requestId`, `userId`, `durationMs` 포함, 비밀값은 `***`). `QA_LOG_LEVEL`로 레벨을 바꿉니다.
- 운영 CLI는 실행 중인 컨테이너에서 씁니다: `docker compose -f docker/compose.yaml exec app node dist/cli.js backup`
- `docker compose down -v`는 볼륨까지 지웁니다. 데이터를 남기려면 `-v` 없이 내립니다.
- `bash docker/smoke.sh`는 이미지 빌드부터 재시작 후 데이터 유지까지 확인합니다(CI `container` 잡).

## 로그인과 사용자

- 처음 기동할 때 `users` 테이블이 비어 있으면 `QA_ADMIN_USERNAME`, `QA_ADMIN_PASSWORD`로 관리자를 만듭니다. 계정이 하나라도 있으면 이 값은 쓰지 않습니다.
- 사용자 추가, 비활성화, 비밀번호 초기화는 관리자만 할 수 있습니다. 로그인 실패가 5번 이어지면 계정이 15분 동안 잠기고, 관리자가 비밀번호를 초기화하면 바로 풀립니다.
- 세션은 30분 동안 요청이 없거나(`QA_SESSION_IDLE_MIN`) 로그인 후 12시간이 지나면 만료됩니다.
- 상태를 바꾸는 API 요청에는 `Origin`(= `QA_PUBLIC_URL`)과 `X-QA-Request: 1` 헤더가 필요합니다. 직접 호출할 때는 두 헤더를 붙이세요.

## 감사 로그

- 로그인 성공·실패, 로그아웃, 사용자 관리, 비밀번호 변경을 기록합니다. 이후 접속·스케줄러 변경과 제어 명령도 같은 곳에 남습니다. 비밀번호 같은 비밀값은 기록하기 전에 가립니다.
- `GET /api/v1/audit-logs`로 조회합니다(기간, 사용자, 스케줄러, 작업 종류, 결과 필터). 수정하거나 지우는 API는 없습니다.
- `QA_AUDIT_RETENTION_DAYS`(기본 365일)가 지난 기록은 매일 새벽 정리 작업이 지웁니다.
- 모든 응답에 `X-Request-Id` 헤더가 붙습니다. 감사 기록의 `requestId`와 같은 값이라 문의할 때 함께 알려주면 추적할 수 있습니다.

## 암호화 키 교체

대상 DB 비밀번호와 알림 웹훅 URL은 `QA_ENCRYPTION_KEYS`의 키로 AES-256-GCM 암호화해 저장합니다.

1. `pnpm --filter @qa/api cli gen-key --id k2`로 새 키를 만듭니다.
2. `QA_ENCRYPTION_KEYS=k1:...,k2:...`, `QA_ENCRYPTION_ACTIVE_KEY=k2`로 바꿉니다.
3. 도구를 멈추고 `pnpm --filter @qa/api cli rotate-keys`를 실행합니다(`--dry-run`으로 미리 확인 가능).
4. 도구를 다시 시작해 확인한 뒤, k1을 키 목록에서 뺍니다.

## 메타데이터 저장소 (SQLite)

- 파일 위치는 `$QA_DATA_DIR/quartz-admin.db`입니다(기본 `/data`, 개발 서버는 `./data`). 기동할 때 마이그레이션을 자동 적용합니다.
- 같은 데이터 디렉터리로 두 번째 인스턴스를 띄우면 기동을 거부합니다.
- 매일 03시(로컬)에 `$QA_DATA_DIR/backups/`로 온라인 백업하고 최신 7개를 남깁니다.

```bash
# 스키마 변경 후 마이그레이션 생성 (apps/api/drizzle/에 커밋)
pnpm --filter @qa/api db:generate --name <변경-이름>

# 수동 백업 (기본 위치 또는 --out 경로)
QA_DATA_DIR=/data pnpm --filter @qa/api cli backup
QA_DATA_DIR=/data pnpm --filter @qa/api cli backup --out /tmp/qa-backup.db
```

복원: 도구를 멈추고, 백업 파일을 `$QA_DATA_DIR/quartz-admin.db`로 복사한 뒤(남아 있는 `-wal`, `-shm` 파일은 삭제) 다시 기동합니다.

## 구조

```
apps/
  api/        NestJS API. 빌드 시 web 정적 결과물을 함께 서빙 (B-06)
  web/        Next.js 관리 UI (output: 'export')
packages/
  shared/     API DTO, zod 요청 스키마, 오류 코드, 공통 상수 (@qa/shared)
  core/       I/O 없는 Quartz 로직: cron 이식, 트리거 계산 (@qa/core)
  store/      대상 DB 접근: QuartzDialect, 자동 감지, 조회·명령 (@qa/store)
              test/support: Testcontainers 통합 테스트 헬퍼
tools/
  quartz-testbed/  Java Quartz 테스트 노드, cron 벡터 생성기 (README 참고)
docker/       Dockerfile, compose.yaml, 컨테이너 스모크 테스트
docs/         PRD, TRD, BACKLOG, DESIGN
```

의존 방향은 `api → store → core`, `api → shared`, `store → shared`, `web → shared`입니다.

## 기여 방식

작업은 [BACKLOG](docs/BACKLOG.md) §1 규칙을 따릅니다. 작업 하나가 `feat/B-xx-<slug>` 브랜치와 PR 하나입니다. 올리기 전에 로컬에서 `pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test`를 돌립니다. PR에서는 CI가 검사, 각 DB 최신 버전의 통합 테스트(4조합), 컨테이너 스모크 테스트를 돌리고, main에 머지되면 4종 DB × 최소·최신 버전 × Quartz 2.3.2/2.5.2 통합 테스트(16조합) 전체를 돕니다.

## 라이선스

MIT. 다른 프로젝트에서 옮겨 온 코드의 고지는 [NOTICE](NOTICE)를 참고하세요.
