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
pnpm --filter @qa/api dev   # NestJS, http://localhost:3000/api/v1
pnpm --filter @qa/web dev   # Next.js 개발 서버
```

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
