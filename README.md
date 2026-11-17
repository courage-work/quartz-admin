# quartz-admin

여러 DB(Oracle, PostgreSQL, MySQL, MariaDB)에 흩어진 Quartz Scheduler 클러스터를 한 화면에서 조회하고 제어하는 사내 운영 도구입니다.

Quartz를 JDBC JobStore 클러스터 모드로 쓰는 서비스는 상태가 각자의 DB에 있는 `QRTZ_` 테이블에만 남습니다. 그래서 배치를 멈추거나 cron을 바꾸려면 서비스를 다시 배포하거나 운영 DB에 직접 SQL을 실행해야 하고, misfire나 노드 다운은 뒤늦게 알게 됩니다. quartz-admin은 이 테이블에 직접 접속해, SQL 콘솔이나 재배포 없이 Quartz 규칙대로 제어하고 이상 징후를 알려 줍니다.

## 주요 기능

**접속과 자동 감지**

- 대상 DB 접속을 등록하면 Quartz 테이블, 테이블 prefix, `SCHED_NAME`, 스키마 버전 차이, 불리언 저장 형식을 찾아 스케줄러 후보로 보여 줍니다.
- 연결 테스트가 실패하면 원인(네트워크, 인증, 권한, 타임아웃)을 구분해 알려 줍니다.
- 쓰기 권한이 없는 계정은 읽기 전용 접속이 되어 조회와 알림만 씁니다.
- DB 비밀번호는 AES-256-GCM으로 암호화해 저장하고 화면, API, 로그 어디에도 평문으로 내보내지 않습니다.

**조회**

- 대시보드: 모든 스케줄러의 상태(정상, 경고, 장애, 연결 불가), 활성 노드 수, 상태별 트리거 수, 실행 중 잡 수, 열린 알림 수. 환경 라벨, 태그, 이름으로 거릅니다.
- 스케줄러 상세: 클러스터 노드와 체크인 상태, 일시정지된 그룹.
- 잡, 트리거, 실행 중 잡 목록: 검색, 필터, 페이지네이션. 활성 노드가 아닌 인스턴스의 실행 기록은 따로 표시합니다.
- 대상 DB 하나에 연결할 수 없어도 다른 스케줄러는 그대로 조회됩니다.

**제어**

- 트리거, 잡, 그룹, 스케줄러 전체의 일시정지와 재개. 여러 건을 골라 한 번에 할 수도 있습니다.
- 즉시 실행, cron·SIMPLE 스케줄 수정(다음 실행 시각 5개 미리보기), 트리거·잡 삭제.
- 안전장치: Quartz와 같은 방식으로 `QRTZ_LOCKS`를 잡은 트랜잭션 안에서 바꾸고, 실행 직전에 상태를 다시 읽어 화면과 다르면 멈춥니다. 실행 전에는 대상, 환경, 영향받는 트리거 수를 확인받습니다.

**알림**

- misfire·실행 지연, ERROR 트리거, BLOCKED 장기 지속, 클러스터 노드 이탈, 감시 불가를 조건 발생 5분 안에 알립니다.
- 채널: 인앱 알림 센터, Slack, 이메일(SMTP). 발생 → 확인 → 해소 수명주기, 중복·폭주 방지, 점검 시간 음소거.

**감사 로그와 사용자**

- 모든 제어 시도(성공, 실패)와 설정 변경, 로그인을 변경 전후 값과 함께 남기고, 화면과 API로는 고치거나 지울 수 없습니다. 필터 조회와 CSV 내보내기를 지원합니다.
- 로컬 계정 로그인, 관리자의 사용자 관리, 세션 만료와 로그인 실패 잠금.

## 지원 범위

| 대상       | 버전                                       |
| ---------- | ------------------------------------------ |
| Oracle     | 12.1 이상 (Instant Client 불필요)          |
| PostgreSQL | 11 이상                                    |
| MySQL      | 5.7 이상                                   |
| MariaDB    | 10.3 이상                                  |
| Quartz     | 2.x 표준 스키마 (테스트 기준 2.3.2, 2.5.2) |
| 브라우저   | 최신 Chrome, Edge, Safari                  |

범위 밖: 잡 실행 이력과 잡 예외 감지, 새 잡 만들기와 JobDataMap 편집, SSO·역할 분리, 임의 SQL 실행, 다중 인스턴스 HA. 자세한 내용은 [PRD](docs/PRD.md) §2, §9에 있습니다.

## 배포

Docker Compose 한 서비스로 단일 호스트에 띄우고, 메타데이터(SQLite)는 볼륨 하나에 저장합니다. 설치, 업그레이드, 백업·복원, 키 교체, 장애 대응은 [운영 런북](docs/operations.md)을 보세요.

## 문서

| 문서                                              | 내용                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| [운영 런북](docs/operations.md)                   | 설치, 리버스 프록시, 배포 보안, 업그레이드, 백업·복원, 장애 대응 |
| [DB 계정](docs/db-accounts.md)                    | 대상 DB 4종의 읽기 전용·쓰기 계정 만들기와 접속 등록             |
| [Oracle 구버전 점검](docs/oracle-legacy-check.md) | 사내 Oracle 12c·19c 점검 이미지와 점검표                         |
| [파일럿 안내](docs/pilot.md)                      | 사내 스케줄러 인벤토리, 파일럿 선정·등록·중단, 성공 지표 측정    |
| [PRD](docs/PRD.md)                                | 사용자, 범위, 기능·비기능 요구사항, 성공 지표                    |
| [TRD](docs/TRD.md)                                | 아키텍처, 저장소 스키마, 제어·감시 설계, 테스트, 환경변수        |
| [BACKLOG](docs/BACKLOG.md)                        | 마일스톤과 작업(B-xx), 진행 규칙, 요구사항 추적                  |
| [DESIGN](docs/DESIGN.md)                          | 디자인 시스템: 테마, 토큰, 상태 표시, 컴포넌트, 린트 규칙        |

## 개발 환경

- Node.js 24 (`.nvmrc`)
- pnpm 10 (`corepack enable`이면 `packageManager` 필드의 버전을 자동 사용)

```bash
pnpm install
pnpm build       # 전체 빌드 (turbo)
pnpm test        # 단위 테스트
pnpm test:integration  # 통합 테스트(Docker 필요, Oracle Free 23 + quartz-testbed)
pnpm e2e        # E2E(Playwright, Chrome·Edge·WebKit). 먼저 pnpm build, Docker 필요
pnpm --filter @qa/store testbed:up  # 손 확인용 Oracle + Quartz 2노드 클러스터(Docker 필요, 접속 정보: packages/store/.testbed.json)
pnpm lint        # ESLint (타입 기반 규칙, 웹 화면은 @shadcn/lint 디자인 규칙 포함)
pnpm typecheck   # TypeScript 검사
pnpm format      # Prettier 적용
```

API는 처음 실행하기 전에 `apps/api/.env`가 필요합니다. 암호화 키는 필수입니다.

```bash
cp apps/api/.env.example apps/api/.env
pnpm --filter @qa/api build
pnpm --filter @qa/api cli gen-key   # 출력값을 .env의 QA_ENCRYPTION_KEYS에 넣는다
```

환경변수 전체 목록은 [TRD §11.2](docs/TRD.md)에 있습니다. 값이 잘못되면 어떤 변수가 왜 틀렸는지 출력하고 기동하지 않습니다.

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

메타데이터 스키마를 바꾼 뒤에는 마이그레이션을 만들어 커밋합니다. 기동할 때 자동으로 적용됩니다.

```bash
pnpm --filter @qa/api db:generate --name <변경-이름>   # apps/api/drizzle/에 생성
```

Windows에 Visual Studio C++ 빌드 도구가 없으면 `pnpm install`이 better-sqlite3의 `node-gyp` 단계에서 실패합니다. better-sqlite3에는 Windows용 사전 빌드 바이너리가 들어 있으므로 `pnpm install --ignore-scripts`로 설치하면 됩니다.

## 구조

```
apps/
  api/        NestJS API. 빌드 시 web 정적 결과물을 함께 서빙
  web/        Next.js 관리 UI (output: 'export')
packages/
  shared/     API DTO, zod 요청 스키마, 오류 코드, 공통 상수 (@qa/shared)
  core/       I/O 없는 Quartz 로직: cron 이식, 트리거 계산 (@qa/core)
  store/      대상 DB 접근: QuartzDialect, 자동 감지, 조회·명령 (@qa/store)
              test/support: Testcontainers 통합 테스트 헬퍼
tools/
  quartz-testbed/  Java Quartz 테스트 노드, cron 벡터 생성기 (README 참고)
docker/       Dockerfile, compose.yaml, 컨테이너 스모크 테스트, Oracle 점검 이미지
e2e/          Playwright E2E
docs/         PRD, TRD, BACKLOG, DESIGN, 운영 문서
```

의존 방향은 `api → store → core`, `api → shared`, `store → shared`, `web → shared`입니다.

## 기여 방식

작업은 [BACKLOG](docs/BACKLOG.md) §1 규칙을 따릅니다. 작업 하나가 `feat/B-xx-<slug>` 브랜치와 PR 하나입니다. 올리기 전에 로컬에서 `pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test`를 돌립니다. PR에서는 CI가 검사, 각 DB 최신 버전의 통합 테스트(4조합), 컨테이너 스모크 테스트를 돌리고, main에 머지되면 4종 DB × 최소·최신 버전 × Quartz 2.3.2/2.5.2 통합 테스트(16조합) 전체를 돕니다.

## 라이선스

MIT. 다른 프로젝트에서 옮겨 온 코드의 고지는 [NOTICE](NOTICE)를 참고하세요.
