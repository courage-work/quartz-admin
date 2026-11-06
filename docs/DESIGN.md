# quartz-admin 디자인 시스템

| 항목 | 내용 |
| --- | --- |
| 문서 버전 | v0.2 |
| 작성일 | 2026-11-06 |
| 관련 작업 | B-37(`docs/BACKLOG.md`) |
| 확인 화면 | `/design` (`apps/web/src/app/design/`) |

화면을 만들 때 이 문서와 `/design` 화면을 기준으로 삼습니다. 규칙 대부분은 `@shadcn/lint`가 `pnpm lint`에서 검사합니다.

## 1. 결정 사항

| 항목 | 결정 | 이유 |
| --- | --- | --- |
| 기반 | shadcn/ui(radix-vega 스타일, Radix) + Tailwind CSS v4 | TRD §1. 표, 폼, 대화상자를 빠르게 구성 |
| 테마 | tweakcn `nature` | 녹색 primary, 베이지 바탕. 장시간 보는 운영 화면에서 눈이 덜 피로함 |
| 본문 폰트 | Pretendard Variable | 한글·영문 모두 지원. nature 원본의 Montserrat에는 한글이 없음 |
| 코드 폰트 | D2Coding | cron 표현식, 트리거·잡 키, 잡 클래스. 한글이 섞여도 폭이 맞음 |
| 폰트 배포 | npm 패키지로 번들에 포함(self-host) | 사내망에서 CDN 없이 동작 |
| 다크 모드 | 라이트 + 다크, 기본은 시스템 설정. 헤더에서 전환 | nature가 두 테마를 모두 제공 |
| 상태 색 | success, warning, info, destructive + neutral | 트리거·스케줄러 상태와 알림 심각도 표현 |
| prod 구분 | 빨간 채운 배지 + 상세 화면·확인 대화상자 맨 위 빨간 띠 | NFR-UX-02 |
| 밀도 | shadcn 기본(컨트롤 높이 36px) | |
| 둥글기 | nature 기본 `--radius: 0.5rem` | |
| 린트 | `@shadcn/lint` 6개 규칙 모두 error | 화면 코드가 아직 없을 때 엄격하게 시작 |

## 2. 파일 위치

| 경로 | 내용 |
| --- | --- |
| `apps/web/src/app/globals.css` | 모든 색·그림자·둥글기 토큰. 라이트는 `:root`, 다크는 `.dark` |
| `apps/web/src/app/layout.tsx` | 폰트 CSS import, `ThemeProvider`, `TooltipProvider`, `Toaster` |
| `apps/web/src/components/ui/` | shadcn 컴포넌트 원본. 스타일은 여기서만 정의 |
| `apps/web/src/components/status/` | 상태·환경 배지, prod 띠, 상태→톤 매핑(`tones.ts`) |
| `apps/web/src/components/code.tsx` | 코드성 텍스트(`<Code>`) |
| `apps/web/src/components/theme-*.tsx` | 테마 공급자와 전환 버튼 |
| `apps/web/components.json` | shadcn CLI 설정 |

## 3. 색

화면 코드에서는 토큰 이름만 씁니다(`bg-primary`, `text-muted-foreground`, `border-border`). `bg-red-500` 같은 Tailwind 기본 팔레트와 `bg-[#fff]` 같은 임의 값은 lint 오류입니다.

### 3.1 기본 토큰

shadcn 표준 토큰(background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart-1~5, sidebar-*)은 tweakcn nature 값을 그대로 씁니다. 다음 값만 바꿨습니다.

| 토큰 | 테마 | nature 원본 | 변경 | 이유 |
| --- | --- | --- | --- | --- |
| `accent`, `sidebar-accent` | 다크 | `oklch(0.5752 0.1446 144)` | `oklch(0.47 0.12 144)` | 위 글자 대비 3.5 → 5.5 |
| `destructive` | 다크 | `oklch(0.5386 0.1937 26.7)` | `oklch(0.68 0.18 25)` | 다크 바탕 위 대비 2.7 → 4.8 |
| `destructive-foreground` | 다크 | 밝은 베이지 | `oklch(0.2 0.03 25)` | 밝아진 빨강 위 글자 대비 확보 |

### 3.2 상태 토큰 (프로젝트 추가)

톤마다 네 가지 토큰이 있습니다.

| 토큰 | 용도 | 예 |
| --- | --- | --- |
| `{tone}` | 채운 면, 점, 아이콘, 띠 | `bg-destructive`(prod 띠) |
| `{tone}-foreground` | `{tone}` 위의 글자 | `text-destructive-foreground` |
| `{tone}-subtle` | 배지·강조 영역 배경 | `bg-warning-subtle` |
| `{tone}-subtle-foreground` | `{tone}-subtle` 위의 글자 | `text-warning-subtle-foreground` |

`tone`은 `success`, `warning`, `info`, `destructive`입니다. 중립 상태(neutral)는 `muted`/`muted-foreground`를 씁니다.

대비 기준: 글자는 4.5:1, 아이콘·점·띠처럼 글자가 아닌 표시는 3:1 이상입니다. 토큰을 바꾸면 라이트·다크 모두에서 다시 확인합니다.

### 3.3 사용 원칙

- 색만으로 상태를 구분하지 않습니다. 상태 배지는 항상 아이콘과 한국어 라벨을 함께 씁니다.
- primary(녹색)는 주요 동작 버튼과 선택 표시에 씁니다. 상태 "정상"(success)도 녹색 계열이지만 배지는 `-subtle` 배경이라 버튼과 구분됩니다.
- 빨강은 오류·장애·삭제와 prod 표시에만 씁니다. 오류 배지는 연한 빨강(`destructive-subtle`), prod 배지는 채운 빨강(`destructive`)으로 구분합니다.

## 4. 상태 표시

매핑의 원본은 `apps/web/src/components/status/tones.ts`입니다. 화면에서는 `TriggerStateBadge`, `SchedulerHealthBadge`, `SeverityBadge`, `EnvBadge`를 씁니다. 원래 값(예: `PAUSED_BLOCKED`)은 배지의 title로 보여 줍니다.

### 4.1 트리거 상태

| 값 | 라벨 | 톤 | 아이콘 |
| --- | --- | --- | --- |
| `WAITING` | 대기 | success | Clock |
| `ACQUIRED` | 획득 | info | CircleDot |
| `EXECUTING` | 실행 중 | info | Play |
| `COMPLETE` | 완료 | neutral | CircleCheck |
| `BLOCKED` | 차단 | warning | Ban |
| `ERROR` | 오류 | destructive | CircleX |
| `PAUSED` | 일시정지 | neutral | Pause |
| `PAUSED_BLOCKED` | 일시정지(차단) | warning | Pause |
| `DELETED` | 삭제됨 | neutral | Trash2 |

`PAUSED`는 운영자가 의도한 상태이므로 경고색을 쓰지 않습니다.

### 4.2 스케줄러 상태와 알림 심각도

| 값 | 라벨 | 톤 |
| --- | --- | --- |
| `ok` | 정상 | success |
| `warning` | 경고 | warning |
| `critical` | 장애 | destructive |
| `unreachable` | 연결 불가 | neutral |

| 심각도 | 라벨 | 톤 |
| --- | --- | --- |
| `info` | 정보 | info |
| `warning` | 경고 | warning |
| `critical` | 심각 | destructive |

### 4.3 환경 라벨 (NFR-UX-02)

- `EnvBadge`: `prod`는 채운 빨강 + 방패 아이콘, `stage`는 warning, 나머지는 neutral입니다.
- `ProdStripe`: prod 스케줄러의 상세 화면 헤더 위와 제어 확인 대화상자 맨 위에 둡니다. prod가 아니면 아무것도 그리지 않으므로 조건 없이 넣어도 됩니다.
- 확인 절차 자체는 환경과 관계없이 같습니다(PRD §4).

## 5. 타이포그래피

| 용도 | 클래스 | 크기 |
| --- | --- | --- |
| 페이지 제목 | `text-2xl font-semibold` | 24px |
| 섹션 제목, 카드 제목 | `text-lg font-semibold` | 18px |
| 본문 | `text-base` | 16px |
| 표, 폼, 메뉴, 보조 본문 | `text-sm` | 14px |
| 캡션, 데이터 기준 시각 | `text-xs text-muted-foreground` | 12px |

- 굵기는 `font-medium`(라벨)과 `font-semibold`(제목) 두 가지만 씁니다.
- 코드성 텍스트(cron 표현식, `그룹.이름` 키, 잡 클래스, 설정 키)는 `font-mono`(D2Coding)입니다. 문장 안에서는 `<Code>`, 표 셀 안에서는 `<span className="font-mono">`로 감쌉니다.
- 표에는 `tabular-nums`가 기본으로 적용돼 시각·건수 열의 숫자 폭이 같습니다(`globals.css`).

D2Coding은 KS X 1001 서브셋을 씁니다. 서브셋에 없는 한글은 Pretendard로 표시됩니다.

## 6. 간격, 밀도, 둥글기

- 간격은 Tailwind 4px 단위(`gap-2`, `p-4`)만 씁니다. 임의 값(`p-[13px]`)은 lint 오류입니다.
- 컨트롤 높이는 shadcn 기본입니다. 버튼·입력 36px(`h-9`), 작은 버튼 32px(`size="sm"`), 큰 버튼 40px(`size="lg"`).
- 둥글기는 `--radius: 0.5rem`에서 계산합니다(`rounded-md` 6.4px, `rounded-lg` 8px, `rounded-xl` 11.2px).
- 페이지 본문 폭은 `max-w-6xl`, 좌우 여백은 `px-6`(모바일 375px에서도 가로 스크롤 없음)입니다.

## 7. 다크 모드

- `next-themes`가 `<html>`에 `light`/`dark` 클래스를 붙입니다. 기본값은 `system`이고 선택값은 `localStorage`의 `theme`에 남습니다.
- 다크 전용 스타일이 필요하면 `dark:` 접두어를 쓰되, 가능하면 토큰 값으로 해결합니다.
- `next-themes`는 첫 화면 깜빡임을 막으려고 인라인 스크립트를 넣습니다. NestJS는 HTML마다 인라인 스크립트의 해시를 CSP에 넣어 서빙하므로(TRD §4.3) 따로 할 일은 없습니다. 화면 코드에서 인라인 스크립트를 직접 추가하지 않습니다.

## 8. 컴포넌트

### 8.1 설치된 컴포넌트

alert, alert-dialog, badge, breadcrumb, button, card, checkbox, dialog, dropdown-menu, empty, field, input, input-group, kbd, label, pagination, popover, radio-group, scroll-area, select, separator, sheet, sidebar, skeleton, sonner, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip

데이터 표는 서버 페이지네이션이라 정렬·필터를 서버가 하므로, TanStack Table을 넣지 않고 shadcn `table`과 `components/schedulers/pagination-bar.tsx`를 씁니다(B-16 결정). 클라이언트 정렬·열 선택이 필요해지면 그때 추가합니다.

원본에서 바꾼 것:

- 스크린 리더용 영문 문구(Close, Toggle Sidebar, Loading 등)를 한국어로 바꿨습니다(NFR-UX-01). 다시 받을 때 확인합니다.
- `hooks/use-mobile.ts`는 effect 안에서 setState를 부르지 않도록 `useSyncExternalStore`로 바꿨습니다(react-hooks 린트).
- `alert`에 상태 톤 variant `success`, `warning`을 더했습니다(B-13, 연결 테스트 결과 안내). 오류는 기존 `destructive`를 씁니다.

### 8.1.1 셸과 화면 공통 부품 (B-06)

| 경로 | 내용 |
| --- | --- |
| `components/shell/` | 인증 확인(`AuthGate`), 사이드바, 본인 메뉴, 화면 제목 줄(`PageHeader`) |
| `components/form/` | react-hook-form 입력(`TextField`), 폼 오류 알림(`FormAlert`) |
| `lib/api.ts` | API 클라이언트. CSRF 헤더, 오류 변환, 세션 만료 시 로그인 이동 |
| `lib/form-errors.ts` | API 오류를 입력별 오류로 옮기는 `applyApiError` |

- 로그인 후 화면은 `app/(app)/` 아래에 둡니다. 레이아웃이 로그인 확인과 사이드바를 맡습니다.
- 상세 화면은 정적 export 제약 때문에 ID를 쿼리로 받습니다(`/audit-log?id=3`). `useSearchParams`를 쓰는 컴포넌트는 `Suspense`로 감쌉니다.
- 조회 화면 공통 부품(B-16, `components/schedulers/`): 새로고침 주기·수동 새로고침·데이터 기준 시각(`RefreshControls`, 주기는 `useSyncExternalStore`로 브라우저 저장값을 읽음), 트리거 표(`TriggerTable`), 사용자·트리거 타임존 시각(`TimeCell`), 이전·다음 페이지(`PaginationBar`). 필터 토글 줄(`ToggleGroup`)과 탭 목록은 좁은 화면에서 넘치지 않게 줄바꿈하거나 가로 스크롤 영역에 둡니다.
- 폼은 `@qa/shared`의 zod 스키마를 `zodResolver`로 그대로 씁니다. 서버와 같은 규칙으로 검증하기 위해서입니다. 폼 값과 요청 형태가 다르면(접속 폼: 포트 문자열, 쉼표 태그, Oracle 접속 방식) 값을 요청 형태로 바꾼 뒤 같은 스키마로 검사하는 resolver를 씁니다(`components/connections/connection-form.tsx`).

### 8.2 추가하는 방법

```bash
cd apps/web
pnpm dlx shadcn@4.23.0 add <컴포넌트>
```

- CLI가 `package.json`에 버전을 직접 적으면 `pnpm-workspace.yaml`의 catalog로 옮기고 `catalog:`로 바꿉니다.
- `badge.tsx`는 상태 variant(success, warning, info, neutral, prod)를 추가했고 destructive를 `-subtle` 토큰으로 바꿨습니다. CLI로 다시 받을 때는 `--diff`로 비교하고 덮어쓰지 않습니다.

### 8.3 스타일을 바꾸고 싶을 때

1. 기존 variant나 size로 해결되는지 봅니다.
2. 바깥 배치(`mt-4`, `w-full`, `flex-1`)는 `className`으로 줄 수 있습니다.
3. 컴포넌트 안쪽 간격·색·글자를 바꿔야 하면, 안에 일반 요소를 두고 그 요소에 클래스를 줍니다(예: `<CardContent><div className="flex flex-col gap-4">…`).
4. 같은 변형이 여러 화면에 필요하면 `components/ui/`의 해당 파일에 variant를 추가하고 이 문서를 고칩니다.

## 9. 린트

`apps/web/src/**/*.tsx`(단, `components/ui/` 제외)에 `@shadcn/lint`를 적용합니다. 설정은 루트 `eslint.config.mjs`에 있고 `pnpm lint`(CI 포함)에서 실행됩니다.

| 규칙 | 막는 것 | 고치는 법 |
| --- | --- | --- |
| `no-restyle` | 컴포넌트에 `className`으로 색·간격·글자·모양 덮어쓰기. 배치(layout)만 허용 | §8.3 |
| `no-raw-colors` | `bg-red-500`, `text-white` 같은 팔레트 색 | §3 토큰 사용 |
| `no-arbitrary-values` | `p-[13px]`, `text-[0.9em]` | 4px 단위 클래스 사용 |
| `no-inline-styles` | `style={{…}}`, `<style>` | 클래스 사용 |
| `no-unknown-classes` | Tailwind가 만들 수 없는 클래스(`rounded-huge`) | 오타 수정 |
| `require-static-classes` | 컴포넌트의 `` `bg-${color}` `` 같은 동적 클래스 | 정적 문자열 맵이나 variant 사용 |

화면을 고친 뒤에는 `pnpm --filter @qa/web lint`로 확인합니다. 오류 메시지가 쓸 수 있는 variant와 토큰을 알려 줍니다.

## 10. 문구

- 화면 문구는 한국어입니다(NFR-UX-01).
- 버튼 라벨은 동사로 시작합니다("저장하기", "트리거 삭제"). "확인", "OK"만 쓰지 않습니다.
- 아이콘만 있는 버튼에는 `aria-label`과 툴팁을 답니다.
- 모든 입력에 보이는 라벨을 둡니다(`FieldLabel`). placeholder는 형식 안내에만 씁니다.
- 오류 문구는 원인과 다음 행동을 함께 씁니다("10초 안에 응답이 없었습니다. 접속 정보를 확인하고 다시 시도하세요.").
