# quartz-admin

여러 DB(Oracle, PostgreSQL, MySQL, MariaDB)에 흩어진 Quartz Scheduler 클러스터를 한 화면에서 조회하고 제어하는 사내 운영 도구입니다.

## 문서

| 문서                       | 내용                                            |
| -------------------------- | ----------------------------------------------- |
| [PRD](docs/PRD.md)         | 사용자, 범위, 기능·비기능 요구사항, 성공 지표   |
| [TRD](docs/TRD.md)         | 아키텍처, 저장소 스키마, 제어·감시 설계, 테스트 |
| [BACKLOG](docs/BACKLOG.md) | 마일스톤과 작업(B-xx), 진행 규칙, 요구사항 추적 |

## 개발 환경

- Node.js 24 (`.nvmrc`)
- pnpm 10 (`corepack enable`이면 `packageManager` 필드의 버전을 자동 사용)

```bash
pnpm install
pnpm build       # 전체 빌드 (turbo)
pnpm test        # 단위 테스트
pnpm test:integration  # 통합 테스트(Docker 필요, Oracle Free 23 + quartz-testbed)
pnpm lint        # ESLint (타입 기반 규칙 포함)
pnpm typecheck   # TypeScript 검사
pnpm format      # Prettier 적용
```

개별 앱 실행:

```bash
pnpm --filter @qa/api dev   # NestJS, http://localhost:3000/api/v1 (데이터: apps/api/data/)
pnpm --filter @qa/web dev   # Next.js 개발 서버
```

API는 처음 실행하기 전에 `apps/api/.env`가 필요합니다. 암호화 키는 필수입니다.

```bash
cp apps/api/.env.example apps/api/.env
pnpm --filter @qa/api build
pnpm --filter @qa/api cli gen-key   # 출력값을 .env의 QA_ENCRYPTION_KEYS에 넣는다
```

환경변수 전체 목록은 [TRD §11.2](docs/TRD.md)에 있습니다. 값이 잘못되면 어떤 변수가 왜 틀렸는지 출력하고 기동하지 않습니다.

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
  shared/     API DTO, 공통 상수 (@qa/shared)
  core/       I/O 없는 Quartz 로직: cron 이식, 트리거 계산 (@qa/core)
  store/      대상 DB 접근: QuartzDialect, 자동 감지, 조회·명령 (@qa/store)
              test/support: Testcontainers 통합 테스트 헬퍼
tools/
  quartz-testbed/  Java Quartz 테스트 노드, cron 벡터 생성기 (README 참고)
docs/         PRD, TRD, BACKLOG
```

의존 방향은 `api → store → core`, `api → shared`, `web → shared`입니다.

## 기여 방식

작업은 [BACKLOG](docs/BACKLOG.md) §1 규칙을 따릅니다. 작업 하나가 `feat/B-xx-<slug>` 브랜치와 PR 하나이며, CI(format, build, lint, typecheck, test)를 통과해야 머지합니다.

## 라이선스

MIT. 다른 프로젝트에서 옮겨 온 코드의 고지는 [NOTICE](NOTICE)를 참고하세요.
