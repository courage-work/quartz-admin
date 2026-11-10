# quartz-admin 디자인 시스템

| 항목 | 내용 |
| --- | --- |
| 문서 버전 | v0.6 |
| 작성일 | 2026-11-06 |
| 관련 작업 | B-37, B-38, B-39, B-40, B-17(`docs/BACKLOG.md`), `.ux-profile.md` |
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
| 면 계층 | 사이드바 < 바탕 < 카드 3단, 카드에 옅은 그림자 | 바탕과 카드가 같은 색이면 면이 테두리로만 구분돼 화면이 납작해 보임(B-39) |
| 밀도 | 마우스는 shadcn 기본(컨트롤 36px), 터치 기기는 44px | 넓은 표를 한눈에 보는 운영 화면이라 마우스 밀도는 유지하고, 터치에서만 WCAG 권장 크기로 키움(B-38) |
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
| `background` | 라이트 | `oklch(0.9711 0.0074 80.7)` | `oklch(0.958 0.0105 79)` | 카드보다 한 단 어둡게(B-39) |
| `card`, `popover` | 라이트 | 바탕과 같음 | `oklch(0.993 0.0035 85)` | 바탕 위로 떠 보이게(B-39) |
| `sidebar` | 라이트 | `oklch(0.937 0.0142 74.4)` | `oklch(0.928 0.0175 75)` | 바탕보다 한 단 어둡게 |
| `sidebar` | 다크 | 바탕과 같음 | `oklch(0.232 0.024 151)` | 바탕보다 한 단 어둡게 |
| `shadow-2xs`, `shadow-xs` | 라이트 | 검정 5% | 따뜻한 갈색 4~5% 두 겹 | 베이지 바탕에서 회색 그림자가 탁해 보임 |
| `shadow-sm`~`shadow-2xl` | 라이트 | 검정 10~25% | 따뜻한 갈색 7% 이하, 넓게 퍼짐 | 라이트 그림자 알파는 0.08 미만(VectorLab colour-palette) |
| `link` (추가) | 라이트 | 없음 | `oklch(0.49 0.13 144.2)` | 글자 링크 색(B-40). primary는 올린 바탕(`link/10`) 위에서 4.4:1이라 한 단 어둡게. 카드 위 5.8:1 |
| `link` (추가) | 다크 | 없음 | `oklch(0.76 0.155 144.2)` | primary는 카드 위 4.3:1이라 한 단 밝게. 카드 위 5.9:1, 올린 바탕 위 4.9:1 |

면은 세 단으로 씁니다. 사이드바(가장 어둡게) → 바탕 → 카드·표 틀·필터 묶음(가장 밝게, `shadow-xs`). 바꾼 뒤 대비는 `muted-foreground`가 바탕·카드·사이드바 위에서 라이트 6.1:1 이상, 다크 7.7:1 이상입니다.

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
| `unreachable` | 연결 불가 | warning |

`unreachable`은 상태를 읽지 못하는 것이라 손봐야 하는 상태입니다. 회색(neutral)이면 정상보다 조용해 보여 warning 톤을 씁니다. 이때 카드와 상세 화면은 warning 알림을 값보다 먼저 두고, 마지막으로 읽은 값(지표 숫자, 분포 막대)은 옅게 보이며 기준 시각을 알림에 적습니다.

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
| 지표 숫자(요약 띠·지표 타일 / 대시보드 카드) | `text-2xl` / `text-xl font-semibold tabular-nums leading-none` | 24px / 20px |
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
- 터치 기기(`pointer: coarse`)에서는 조작 요소가 44px입니다. `components/ui/`의 버튼·입력·선택 상자·토글·탭·사이드바 항목에 `pointer-coarse:h-11`(아이콘 버튼 `pointer-coarse:size-11`)을, 메뉴 항목에 `pointer-coarse:py-3`을 넣었고, 체크박스·라디오·스위치는 `after:` 가상 요소로 보이지 않는 터치 영역을 44px까지 넓혔습니다. 표·문장 안의 텍스트 링크는 WCAG 인라인 예외로 둡니다(B-38).
- 화면 폭 기준은 3개입니다. narrow 375px, medium 768px(`md:`), wide 1280px(`xl:`). 화면 코드에서는 `md:`, `xl:`만 씁니다(shadcn 원본 안의 `sm:`는 그대로 둠).
- 둥글기는 `--radius: 0.5rem`에서 계산합니다(`rounded-md` 6.4px, `rounded-lg` 8px, `rounded-xl` 11.2px).
- 페이지 본문 폭은 `max-w-6xl`, 좌우 여백은 `px-6`(모바일 375px에서도 가로 스크롤 없음)입니다. 열이 많은 표가 있는 화면(스케줄러 상세)은 `page.tsx`에 `WidePage`(`components/shell/wide-page.tsx`)를 두어 96rem까지 넓힙니다.

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
- `dropdown-menu`의 메뉴 너비를 트리거 너비(`w-(--radix-dropdown-menu-trigger-width)`)에서 내용 너비(`w-max`, 화면 안 최대 너비까지)로 바꿨습니다. 아이콘 버튼(36px)으로 여는 메뉴가 최소 128px에 묶여 "시스템 설정" 같은 항목이 줄바꿈되던 문제입니다(B-39).
- 대화상자·시트 배경(overlay)의 흐림(`backdrop-blur-xs`)을 빼고 `bg-black/40`으로 가렸습니다. 흐림은 경계가 흐려 보여 쓰지 않습니다(VectorLab anti-slop, B-39 점검).
- 드롭다운·팝오버·선택 상자·툴팁의 등장 효과에서 95% 확대(`zoom-in-95`)를 빼고 투명도만 바꿉니다(VectorLab transitions: 팝오버는 투명도, 크기 변화 1.02 이하).
- 사이드바 접기·펼치기에서 너비·위치 전환(`transition-[width]` 등)을 빼 즉시 바뀌게 했습니다. 너비는 애니메이션하지 않습니다(VectorLab motion).
- `table`의 칸 여백을 넓혔습니다. 머리 칸 `h-10 px-2` → `h-11 px-3`, 본문 칸 `p-2` → `px-3 py-3`, 첫·끝 칸은 `pl-4`/`pr-4`로 표 틀 테두리와 띄웁니다. 한 줄 행이 38px에서 46px이 됐습니다. 원본 여백은 열 사이와 행 위아래가 빡빡해 보였습니다(B-40).
- `table`의 `TableHead`·`TableCell`에 `pinned`를 더했습니다. 줄 끝 제어 메뉴 칸을 오른쪽에 고정해, 표가 가로로 스크롤돼도 보이는 폭 안에 남깁니다. 고정 칸은 면 색(`bg-card`)을 깔고 줄 바탕(올림, 머리 줄)은 `::before`로 덧칠하며, 왼쪽 가는 선으로 밑에 다른 칸이 지나감을 알립니다. 트리거 표가 씁니다.
- `table`의 스크롤 틀(`table-container`)을 container(`@container/table`)로 두었습니다. 빈 표 표시를 보이는 폭에 맞추기 위해서입니다(B-40).
- `button`의 `destructive`를 `-subtle` 토큰 쌍으로 바꿨습니다(원본은 `destructive/10` 바탕 + `destructive` 글자라 대비가 라이트 4.2:1, 다크 3.7:1). `tabs`의 비활성 탭 글자는 `foreground/60`(라이트 3.8:1)에서 `muted-foreground`로 바꿨습니다.
- `card`에 `interactive`를 더했습니다. 카드 전체가 링크일 때 올림·포커스 표시를 카드가 맡습니다(B-40).

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
- 화면에 바로 놓이는 목록 표는 `components/table-frame.tsx`(테두리 + `bg-card`)로 감쌉니다. 카드 안의 표는 감싸지 않습니다(이중 테두리). 표가 넓으면 틀 안에서 가로로 스크롤하며, 이를 위해 본문(`SidebarInset`)에 `min-w-0`을 둡니다(B-16 UX 점검).
- 이동 링크는 밑줄 대신 줄·카드 전체를 누르게 하거나 링크 색으로 보입니다(B-40, §8.1.4).
- 폼은 `mode: 'onSubmit'`이고 칸별 검사는 `TextField`가 맡습니다. 값을 바꾼 칸만 벗어날 때 검사하고, 오류가 뜬 칸은 고치는 즉시 다시 검사해 지웁니다. 아무것도 입력하지 않은 칸은 포커스가 빠져도(자동 포커스 뒤 다른 곳 클릭 등) 오류를 띄우지 않고 저장할 때 검사합니다. 입력 중인 칸에는 오류를 띄우지 않습니다(B-40). 제출 버튼은 입력이 덜 됐다고 막지 않고, 누르면 무엇이 필요한지 알려 줍니다.
- 새 접속 폼은 입력을 1초 뒤 브라우저에 임시 저장하고(비밀번호 제외) 다시 열면 불러옵니다. 배너에서 버릴 수 있고, 저장에 성공하면 지웁니다.
- 대화상자를 Radix Trigger가 아닌 버튼·메뉴 항목으로 열면 닫힌 뒤 포커스를 연 자리로 직접 돌려줍니다(`DeleteImpactDialog`의 `returnFocus`).
- **조회에 실패했거나 아직 읽는 중이어도 화면 머리(`PageHeader`의 경로와 돌아가기)는 남깁니다.** 본문 자리에만 알림이나 스켈레톤을 둡니다.
- **표가 비면 모든 표가 `TableEmpty`를 씁니다.** 카드 안의 표(JobDataMap)와 한 칸짜리 표(일시정지 그룹)도 회색 글 한 줄 대신 같은 모양입니다. 접속 상세의 "등록한 스케줄러"만 예외로 한 줄 글입니다. 다음 할 일(감지한 후보 등록)이 바로 아래 카드에 있어, 큰 빈 표시가 그 카드를 첫 화면 밖으로 밀어내기 때문입니다. 표가 아닌 빈 화면(대시보드의 검색 결과 없음)도 아이콘을 둡니다. 표 폭 가운데에 아이콘과 제목(필요하면 설명), 지울 수 있으면 지우기 버튼(outline)을 둡니다. 아이콘은 아무것도 없을 때 그 표의 대상(사용자, 잡, 트리거, 노드 등), 검색·필터 결과가 없을 때 `SearchXIcon`입니다. 넓은 표가 가로로 스크롤돼도 보이는 폭 가운데에 있도록 표 스크롤 틀을 container로 두고(`ui/table.tsx`의 `@container/table`) `empty-fit-frame` 유틸리티로 고정합니다(B-40).
- 필터 결과가 비면 "필터 모두 지우기"를 함께 보여 줍니다. 검색·필터를 걸지 않은 빈 목록에는 "조건에 맞는", "검색어에 맞는" 문구와 지우기 버튼을 쓰지 않고 "등록된 잡이 없습니다"처럼 씁니다(B-40). placeholder는 형식 예시에만 쓰고, 검색 범위는 라벨에 씁니다(예: `검색어(이름·그룹·잡)`).
- `prefers-reduced-motion: reduce`이면 애니메이션·전환을 즉시 끝냅니다(`globals.css`). 새로고침 스피너는 100ms 넘게 걸릴 때만 보입니다.
- 폼은 `@qa/shared`의 zod 스키마를 `zodResolver`로 그대로 씁니다. 서버와 같은 규칙으로 검증하기 위해서입니다. 폼 값과 요청 형태가 다르면(접속 폼: 포트 문자열, 쉼표 태그, Oracle 접속 방식) 값을 요청 형태로 바꾼 뒤 같은 스키마로 검사하는 resolver를 씁니다(`components/connections/connection-form.tsx`).

### 8.1.2 상태가 보이는 화면 (B-39)

| 경로 | 내용 |
| --- | --- |
| `components/shell/brand-mark.tsx` | 브랜드 마크. 사이드바 머리와 로그인 화면에 쓴다 |
| `components/dashboard/health-summary.tsx` | 대시보드 요약 띠. 전체·장애·연결 불가·경고·정상 수. 누르면 그 상태만 화면에서 거른다(`aria-pressed`) |
| `components/dashboard/trigger-distribution.tsx` | 트리거 상태 분포 막대. 인라인 스타일 없이 SVG 좌표로 그리고, 상태별 수를 `aria-label`로 전한다 |
| `components/schedulers/scheduler-stats.tsx` | 스케줄러 상세 지표 띠(활성 노드, 트리거+분포, 실행 중, 오류·차단) |
| `components/status/tones.ts`의 `TONE_CLASSES` | 톤별 정적 클래스(띠 `rail`, SVG `fill`, 아이콘 바탕 `soft`, 작은 아이콘 `text`). `bg-${tone}`처럼 만들지 않는다 |

- 손볼 것이 먼저 보이게 합니다. 대시보드 카드는 장애 → 연결 불가 → 경고 → 정상 → 감시 전 순서이고, 같은 상태는 이름순입니다.
- 강조는 문제가 있을 때만 씁니다. 요약 띠와 지표 타일은 값이 0이면 중립(muted) 아이콘 바탕, 0보다 크면 해당 톤의 `-subtle` 바탕을 씁니다.
- 카드 위 4px 상태 띠(`rail`)는 보조 표시입니다. 상태의 뜻은 항상 배지(아이콘 + 글자)가 전합니다.
- 요약 띠는 좁은 화면(`sm` 미만)에서 톤 바탕 아이콘을 숨기고, 라벨 옆에 톤 색 작은 아이콘(`text`)을 둡니다. `xl` 미만에서는 두 줄입니다: 첫 줄 셋, 둘째 줄 둘이 한 줄을 반씩 채워 빈칸이 없습니다(6칸 격자).
- 이 부품들은 `/design`의 "상태 요약" 구역에서 예시 값으로 확인합니다.
- 분포 막대(`TriggerDistribution`)는 범례 배지(`TriggerLegend`)와 함께 둡니다. 막대만으로 수를 읽게 하지 않습니다. 대시보드 카드는 막대 아래, 상세 지표 타일은 숫자 옆에 둡니다.
- 목록 위에는 검색칸과 "필터" 버튼(팝오버)만 두어 표가 첫 화면에 보이게 합니다(§8.1.3). 필터를 면 하나에 펼쳐 두지 않습니다.
- 상세 화면 탭은 `TabsList variant="line"`과 아래 테두리로 표 위 구역을 나눕니다.
- 표 틀(`TableFrame`)의 머리 줄은 `bg-muted/60`입니다.
- **한 표 안의 줄 높이는 모두 같습니다.** 값이 있을 때만 생기는 줄(태그, 캘린더 등)을 칸 안에 덧붙이지 않습니다. 따로 한 줄 칸을 두고 길면 자르거나(`truncate`, 전체는 `title`), 늘 있는 줄 뒤에 `·`로 잇습니다. 두 줄 칸(그룹 / 이름)을 쓰는 표는 모든 줄이 두 줄입니다. `Code` 칩은 flex 항목으로 두지 말고 고정폭 글꼴 글줄(`<span className="font-mono">`) 안에 둡니다. 세로 여백과 글꼴 섞임으로 줄이 1~4px 높아집니다(B-40).
- 정적인 메타데이터(접속 태그 등)는 알약 배지로 감싸지 않고 `·`로 이은 글자로 씁니다. 배지는 상태·환경처럼 뜻이 있는 값에만 씁니다.
- 일시정지 그룹처럼 이름만 있는 목록도 표 틀 안의 목록으로 보여 줍니다.
- 모든 폼은 `mode: 'onSubmit'`입니다(값을 바꾼 칸만 벗어날 때 검사, 오류가 뜬 칸은 고칠 때 다시 검사, 빈 칸은 저장할 때 검사). 폼에 쓰는 zod 스키마는 한국어 오류 문구를 둡니다.

### 8.1.3 목록·폼·오버레이 기준 (B-38)

| 경로 | 내용 |
| --- | --- |
| `components/list/list-search.tsx` | 목록 검색칸. 보이는 라벨(`검색(범위)`), 돋보기, `/` 단축키 표시. Esc로 지운다 |
| `hooks/use-slash-focus.ts` | 화면 어디서든 `/`로 검색칸에 포커스. 입력 중이거나 대화상자가 열려 있으면 건너뛴다 |
| `lib/paging.ts` | 화면에서 나누는 목록의 페이지(50건)와 검색어 일치 |
| `components/table-empty.tsx` | 표 안 "데이터 없음" 줄(`TableEmpty`). 아이콘·제목·설명·지우기 버튼을 표의 보이는 폭 가운데에 둔다(B-40) |
| `components/form/form-row.tsx` | 화면 폼의 한 줄(`FormRow`): 왼쪽 1/4 라벨, 오른쪽 3/4 입력. `TextField layout="row"`가 이걸 쓴다(B-40) |
| `components/form/form-actions.tsx` | 폼 아래 취소·저장 줄. 화면 아래에 붙어 있다(`sticky bottom-0`) |
| `components/form/form-alert.tsx` | 서버·네트워크 오류면 "오류 정보 복사"(시각, 요청, 상태, 요청 ID, 메시지)를 함께 둔다 |

- **목록 화면**(접속, 사용자, 감사 로그): 검색칸은 항상 보이고 `/`로 포커스합니다. 표는 표 틀 안에 두고, 결과가 없으면 표 틀 안에서 알리며 지우기 버튼을 둡니다. 페이지 이동 줄은 한 쪽뿐이어도 보입니다. 기본 정렬은 접속 이름순, 사용자 아이디순, 감사 로그 최신순입니다.
- **필터 팝오버**(감사 로그, 트리거 탭): "필터" 버튼 하나에 조건을 모으고(감사 로그: 기간·작업 종류·결과, 트리거: 상태·타입·그룹), 적용한 값은 툴바 아래 칩(`components/list/filter-chips.tsx`)으로 보여 하나씩 지울 수 있게 합니다. 조건이 하나뿐인 잡 탭은 팝오버 없이 그룹 선택 상자를 검색칸 옆에 둡니다. 감사 로그의 사용자 아이디는 검색칸에서 부분 일치로 찾습니다(다른 서버 검색칸처럼 입력을 멈추면 적용).
- **트리거 표의 타입**은 열을 따로 두지 않고 일정 칸의 둘째 줄에 씁니다(`Cron · Etc/UTC`, `단순 반복`). 열 하나만큼 표가 좁아져 1440px에서 가로로 넘치지 않습니다. 모든 줄이 두 줄(일정 / 타입·타임존)이라 줄 높이는 같습니다.
- **트리거 표 정렬**은 열 머리("그룹 / 이름", "다음 실행")를 눌러 바꿉니다. 서버가 오름차순만 주므로 방향은 없고, 정렬 중인 열에 화살표와 `aria-sort`를 둡니다. 따로 정렬 선택 상자를 두지 않습니다.
- **빠른 기간**: 감사 로그 필터의 "오늘", "최근 7일", "최근 30일"은 시작일·종료일을 한 번에 채웁니다.
- **그룹 필터**는 대상 DB에 있는 그룹 중에서 고릅니다(`components/schedulers/group-field.tsx`, `GET /schedulers/:id/groups`). 그룹이 200개를 넘으면 선택 상자 대신 직접 입력(정확히 일치)을 받습니다.
- **서버에 묻는 검색칸**(대시보드, 스케줄러의 트리거·잡 탭)은 입력을 멈추면 0.3초 뒤 적용합니다(Enter는 바로). "검색하기" 버튼은 두지 않습니다.
- **감사 로그의 글꼴**: 식별자(사용자 아이디, 트리거 키, IP)는 고정폭, 사람이 붙인 이름(접속, 스케줄러)과 "시스템"은 본문 글꼴입니다.
- `/` 단축키는 대시보드, 스케줄러의 트리거·잡 탭 검색칸에도 있습니다. 검색칸은 모두 `ListSearch` 모양(돋보기, `/` 표시)이고, 서버에 묻는 목록은 `ServerSearch`(`components/list/server-search.tsx`)를 씁니다.
- **오버레이 선택**: 10초 안쪽 작업은 오른쪽 시트(비밀번호 초기화), 그보다 긴 입력은 별도 화면(`/users/new` 사용자 추가, `/scheduler/settings?id=N` 스케줄러 설정)입니다. 삭제·해제·비활성화는 대상 이름을 쓴 확인 대화상자입니다.
- **제어 명령**(B-17, FR-CTL-00b): 트리거 표(트리거 탭, 잡 상세) 줄 끝의 아이콘 메뉴(`TriggerActions`, 툴팁 "… 트리거 제어")에서 고르면 공통 확인 대화상자(`CommandDialog`)가 열립니다. 대화상자는 열 때마다 서버 미리보기를 읽어 맨 위 prod 띠, 스케줄러(표시 이름·환경 배지·접속·SCHED_NAME), 대상(그룹·이름·지금 상태·잡), 영향 범위(바뀌는 트리거 수와 바뀌기 전 → 후 상태 배지), 대상 DB 시각을 보여 줍니다. 실행 버튼은 동사("일시정지하기")이고 실행 중에는 스피너를 붙이며 대화상자를 닫지 못하게 합니다. 결과는 알림(성공은 success, 바뀐 것이 없으면 info)으로 알리고 스케줄러 화면의 조회를 다시 읽습니다. 실행 직전 상태가 달라 멈췄으면(`STATE_CONFLICT`) 대화상자 안에 warning 알림을 두고 내용을 최신 상태로 다시 읽어, 사용자가 확인한 뒤 다시 누르게 합니다. 읽기 전용이거나 쓰기 권한을 확인하지 못한 접속은 메뉴 맨 위에 이유를 적고 항목을 끄며, 대화상자에서도 destructive 알림으로 막습니다. 지금 상태에서 바뀌는 것이 없는 항목(이미 일시정지된 트리거의 일시정지)은 끕니다.
- 감사 로그에서 작업 도중 서버가 꺼져 결과를 모르는 기록(`INTERRUPTED`)은 "실패" 대신 warning "결과 확인 필요" 배지로 보여 줍니다.
- **스케줄러 설정으로 가는 길**은 둘입니다: 접속 상세의 줄 메뉴, 스케줄러 상세 머리의 설정 아이콘 버튼. 스케줄러 상세에서 들어가면(`from=scheduler`) 경로, 사이드바에서 고른 메뉴, 저장·취소 뒤 돌아갈 곳이 모두 스케줄러 상세 쪽입니다.
- **스케줄러 감지 후보**는 그 접속에 등록한 스케줄러가 아직 없을 때만 모두 골라 둡니다(처음 등록하는 흐름). 이미 등록한 것이 있으면 남은 후보는 고르지 않은 채로 둡니다.
- **화면 폼 배치**(접속 추가·수정, 스케줄러 설정, 사용자 추가): 본문 폭을 다 쓰는 카드에 라벨 칸(1/4)과 입력 칸(3/4)을 둡니다(`FormRow`, `TextField layout="row"`). 상세 화면 정보 카드(`dl`, `md:grid-cols-4`)와 같은 비율·카드 나눔·카드 제목·순서로 맞춰 상세 ↔ 수정을 오가도 값의 자리가 같습니다(접속: "접속 정보" → "표시와 권한"). 입력 폭은 값 길이에 맞춥니다(기본 `max-w-xl`, 포트·숫자·환경은 `size="short"`). 좁은 화면에서는 라벨이 입력 위로 옵니다. 로그인·시트처럼 좁은 곳은 라벨을 위에 두는 기본 배치(`layout="stack"`)를 씁니다(B-40).
- **폼 안전장치**: 접속 추가·수정 폼은 입력을 1초 뒤 임시 저장합니다(비밀번호 제외, 수정은 접속마다 따로, 그 사이 접속이 바뀌었으면 버림). 저장하지 않은 변경이 있으면 새로고침·탭 닫기 전에 브라우저가 묻습니다.

### 8.1.4 이동과 돌아가기 (B-40)

| 경로 | 내용 |
| --- | --- |
| `components/shell/page-header.tsx`의 `trail` | 상위 화면을 위에서부터 넘긴다. 넓은 화면(`md` 이상)은 상단 바에 경로와 지금 화면 이름을, 좁은 화면은 제목 위에 상위 화면만 그린다. 제목 왼쪽에는 마지막 상위 화면으로 가는 돌아가기 버튼이 붙는다 |
| `components/shell/top-trail.tsx` | 상단 바에서 경로를 그릴 자리(`TopTrailSlotContext`). 레이아웃이 자리를 두고 `PageHeader`가 포털로 그린다. 상단 바는 스크롤해도 붙어 있어 제목이 화면 밖으로 나가도 어느 화면인지 보인다 |
| `components/shell/quick-nav.tsx`, `lib/quick-nav.ts` | 빠른 이동(헤더 버튼, Ctrl+K·⌘K). 화면·스케줄러·접속을 이름으로 찾아 바로 간다. 검색칸은 combobox, 목록은 listbox이고 위·아래 키로 고른다 |
| `lib/page-title.ts` | 상세 화면의 브라우저 탭 제목을 대상 이름으로 바꾼다(`usePageTitle`) |
| `components/shell/back-nav.tsx` | 돌아가기 버튼(`BackButton`, 아이콘 버튼 + 툴팁 "돌아가기: 화면")과 경로(`PageTrail`) |
| `lib/return-nav.ts` | 화면마다 마지막 주소를 기억한다(키: 경로 + `id`, sessionStorage). 레이아웃의 `ReturnNavTracker`가 기록한다 |
| `lib/use-url-state.ts` | 목록 상태(필터·검색어·쪽) ↔ 주소 쿼리. `history.replaceState`라 기록이 쌓이지 않는다 |
| `components/links.tsx` | 줄 링크(`LinkRow`, `RowLink`, `RowChevronHead`/`RowChevronCell`)와 글자 링크(`InlineLink`) |
| `components/ui/card.tsx`의 `interactive` | 카드 전체가 링크인 카드. 안의 `data-card-link` 링크가 카드를 덮는다 |

- **목록 상태는 주소에 둡니다.** 대시보드(`env`, `tag`, `q`, `health`), 접속(`q`, `page`), 감사 로그(`from`, `to`, `action`, `result`, `user`), 스케줄러의 잡 탭(`group`, `q`, `page`)·트리거 탭(`state`, `type`, `group`, `q`, `sort`, `page`). 상세에 갔다 뒤로 가기나 돌아가기로 오면 그대로이고, 주소를 공유해도 같은 목록이 보입니다. 탭을 바꾸면 이전 탭의 값은 버립니다.
- **상세·하위 화면은 `PageHeader`에 `trail`을 넘깁니다.** 경로에는 상위 화면만 두고 지금 화면은 제목이 보입니다. 경로와 돌아가기 버튼은 그 화면을 마지막으로 본 주소(필터·탭 포함)로 갑니다. 그 주소가 바로 이전 화면이면 브라우저 뒤로 가기로 가서 스크롤 위치까지 되살립니다. 새 탭으로 열기(가운데·Ctrl 클릭)는 그대로 링크입니다.
- **줄 하나가 상세 하나인 목록 표**(접속, 감사 로그, 잡 탭)는 줄 전체가 링크입니다. 대표 칸의 이름은 굵은 본문 색, 줄 끝에 `›`를 두고, 올리면 줄 바탕·이름 색(`link`)이 바뀌며 `›`가 2px 움직입니다. 포커스 링은 줄 전체에 그립니다. 한 줄에 줄 링크는 하나이고, 줄 안에 다른 버튼이 있는 표에는 쓰지 않습니다.
- **다른 화면을 가리키는 칸 안의 링크**(트리거 줄의 잡, 스케줄러 상세의 접속, 접속 상세의 스케줄러)는 `InlineLink`입니다. `link` 색 글자이고, 올리면 `link/10` 바탕이 깔립니다. 밑줄은 쓰지 않습니다.
- **대시보드 카드**는 카드 전체가 스케줄러 상세 링크입니다(`Card interactive`). 제목 옆에 `›`, 올리면 테두리·그림자·제목 색이 바뀝니다.

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

### 8.4 검토하고 그대로 두기로 한 것

| 제안 | 결정 | 이유 |
| --- | --- | --- |
| 접속 상세를 넓은 화면에서 2열로, 제목과 카드의 이름·환경 중복 제거 | 그대로 둠 | 상세 화면과 수정 폼의 카드 나눔·순서·비율을 같게 맞춘 규칙(§8.1.3)이 우선입니다. 폼을 2열로 나누면 읽는 순서가 흐트러집니다 |
| 새로고침 컨트롤을 한 덩이로 줄이기 | 그대로 둠 | "자동 새로고침" 라벨을 없애야 줄어드는데, 모든 입력에 보이는 라벨을 두는 규칙(§10)과 맞지 않습니다 |
| 상세 화면 탭에 건수 표시 | 넣지 않음 | 건수는 감시 스냅샷 값이고 탭 안 목록은 대상 DB에서 바로 읽은 값이라 서로 어긋날 수 있습니다 |
| 표 머리 줄을 스크롤해도 붙어 있게 | 넣지 않음 | 표가 가로로 스크롤하는 틀 안에 있어 화면 스크롤에 붙일 수 없고, 표 안쪽 세로 스크롤로 바꾸면 화면과 표가 따로 스크롤됩니다. 대신 상단 바의 경로가 지금 화면을 알려 줍니다 |

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
- 버튼 라벨은 동작을 씁니다. "확인", "OK"만 쓰지 않습니다. 화면과 대화상자의 버튼은 "…하기"로 맞춥니다("접속 추가하기", "수정하기", "삭제하기", "필터 적용하기", "초기화하기"). 같은 동작은 어디서나 같은 문구입니다(목록 머리와 빈 화면의 "접속 추가하기"). 메뉴 항목은 짧은 명사형입니다("일시정지", "설정", "등록 해제"). "취소", "새로고침"처럼 굳은 말은 그대로 씁니다.
- 지우는 버튼(접속 "삭제하기", 메뉴의 "등록 해제", 확인 대화상자의 실행 버튼)은 `destructive` 모양입니다.
- 아이콘만 있는 버튼에는 `aria-label`과 툴팁을 답니다.
- 토글(필터 팝오버의 상태·타입)의 고른 상태는 선택 표시 색입니다(`accent` 바탕 + `primary` 테두리). 바탕만 살짝 어두워지는 원본은 고른 것과 안 고른 것이 잘 구분되지 않았습니다.
- 로그인 후 화면 맨 앞에는 "본문으로 건너뛰기" 링크가 있습니다(키보드 포커스를 받을 때만 보임).
- 모든 입력에 보이는 라벨을 둡니다(`FieldLabel`). placeholder는 형식 안내에만 씁니다.
- 오류 문구는 원인과 다음 행동을 함께 씁니다("10초 안에 응답이 없었습니다. 접속 정보를 확인하고 다시 시도하세요.").
