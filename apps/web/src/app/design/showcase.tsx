'use client';

import { SCHEDULER_HEALTH, SEVERITIES } from '@qa/shared';
import {
  InboxIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

import { Code } from '@/components/code';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import {
  SchedulerHealthBadge,
  SeverityBadge,
  TriggerStateBadge,
} from '@/components/status/status-badge';
import { TRIGGER_STATE_META, type TriggerState } from '@/components/status/tones';
import { ThemeToggle } from '@/components/theme-toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const SWATCHES = [
  { name: 'background', className: 'bg-background text-foreground' },
  { name: 'card', className: 'bg-card text-card-foreground' },
  { name: 'muted', className: 'bg-muted text-muted-foreground' },
  { name: 'primary', className: 'bg-primary text-primary-foreground' },
  { name: 'secondary', className: 'bg-secondary text-secondary-foreground' },
  { name: 'accent', className: 'bg-accent text-accent-foreground' },
  { name: 'success', className: 'bg-success text-success-foreground' },
  { name: 'warning', className: 'bg-warning text-warning-foreground' },
  { name: 'info', className: 'bg-info text-info-foreground' },
  { name: 'destructive', className: 'bg-destructive text-destructive-foreground' },
  { name: 'success-subtle', className: 'bg-success-subtle text-success-subtle-foreground' },
  { name: 'warning-subtle', className: 'bg-warning-subtle text-warning-subtle-foreground' },
  { name: 'info-subtle', className: 'bg-info-subtle text-info-subtle-foreground' },
  {
    name: 'destructive-subtle',
    className: 'bg-destructive-subtle text-destructive-subtle-foreground',
  },
] as const;

const SAMPLE_TRIGGERS: {
  group: string;
  name: string;
  cron: string;
  state: TriggerState;
  next: string;
}[] = [
  {
    group: 'BILLING',
    name: 'monthly-invoice',
    cron: '0 0 2 1 * ?',
    state: 'WAITING',
    next: '2026-12-01 02:00:00',
  },
  {
    group: 'BILLING',
    name: 'settle-daily',
    cron: '0 30 1 * * ?',
    state: 'EXECUTING',
    next: '2026-11-07 01:30:00',
  },
  {
    group: 'REPORT',
    name: 'weekly-kpi',
    cron: '0 0 9 ? * MON',
    state: 'PAUSED',
    next: '2026-11-09 09:00:00',
  },
  {
    group: 'SYNC',
    name: 'erp-orders',
    cron: '0 */5 * * * ?',
    state: 'ERROR',
    next: '-',
  },
];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function DesignShowcase() {
  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-baseline gap-3">
            <span className="font-semibold">quartz-admin</span>
            <span className="text-sm text-muted-foreground">디자인 시스템</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-12 px-6 py-10">
        <Section
          id="colors"
          title="색"
          description="tweakcn nature 테마 + 상태 색 4종. 화면 코드에서는 토큰 이름(bg-primary, text-muted-foreground)만 쓴다."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {SWATCHES.map((swatch) => (
              <div key={swatch.name} className="overflow-hidden rounded-lg border">
                <div className={swatch.className}>
                  <div className="flex h-16 items-end p-2 text-xs font-medium">Aa 가나다</div>
                </div>
                <div className="bg-card px-2 py-1.5 font-mono text-xs">{swatch.name}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="typography"
          title="타이포그래피"
          description="본문은 Pretendard Variable, 코드성 텍스트는 D2Coding. 표의 숫자는 tabular-nums로 폭을 맞춘다."
        >
          <Card>
            <CardContent>
              <div className="flex flex-col gap-3">
                <p className="text-2xl font-semibold">페이지 제목 24px semibold</p>
                <p className="text-lg font-semibold">섹션 제목 18px semibold</p>
                <p className="text-base">본문 16px. 스케줄러 상태를 한 화면에서 확인합니다.</p>
                <p className="text-sm">보조 본문 14px. 표, 폼, 메뉴의 기본 크기입니다.</p>
                <p className="text-xs text-muted-foreground">
                  캡션 12px. 데이터 기준 시각 2026-11-06 10:24:13
                </p>
                <p className="text-sm">
                  트리거 <Code>BILLING.monthly-invoice</Code> 의 스케줄은 <Code>0 0 2 1 * ?</Code>{' '}
                  (Asia/Seoul), 잡 클래스는 <Code>com.example.batch.InvoiceJob</Code> 입니다.
                </p>
              </div>
            </CardContent>
          </Card>
        </Section>

        <Section
          id="status"
          title="상태 표시"
          description="색만으로 구분하지 않도록 아이콘과 한국어 라벨을 함께 쓴다. 원래 값은 마우스를 올리면 보인다."
        >
          <Card>
            <CardContent>
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">트리거 상태</p>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(TRIGGER_STATE_META) as TriggerState[]).map((state) => (
                      <TriggerStateBadge key={state} state={state} />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">스케줄러 상태</p>
                  <div className="flex flex-wrap gap-2">
                    {SCHEDULER_HEALTH.map((health) => (
                      <SchedulerHealthBadge key={health} health={health} />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">알림 심각도</p>
                  <div className="flex flex-wrap gap-2">
                    {SEVERITIES.map((severity) => (
                      <SeverityBadge key={severity} severity={severity} />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">환경 라벨</p>
                  <div className="flex flex-wrap gap-2">
                    <EnvBadge environment="prod" />
                    <EnvBadge environment="stage" />
                    <EnvBadge environment="dev" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="overflow-hidden rounded-lg border">
            <ProdStripe environment="prod" name="billing-cluster" />
            <div className="flex items-center justify-between bg-card p-4">
              <div className="flex flex-col gap-1">
                <p className="font-semibold">billing-cluster</p>
                <p className="text-sm text-muted-foreground">
                  prod 스케줄러 상세 화면과 제어 확인 대화상자 맨 위에 빨간 띠를 둔다.
                </p>
              </div>
              <SchedulerHealthBadge health="ok" />
            </div>
          </div>
        </Section>

        <Section
          id="buttons"
          title="버튼"
          description="라벨은 동사로 시작한다. 아이콘만 있는 버튼에는 툴팁과 aria-label을 단다."
        >
          <Card>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button>저장하기</Button>
                  <Button variant="secondary">미리보기</Button>
                  <Button variant="outline">취소</Button>
                  <Button variant="ghost">닫기</Button>
                  <Button variant="destructive">
                    <Trash2Icon data-icon="inline-start" />
                    트리거 삭제
                  </Button>
                  <Button variant="link">감사 로그 보기</Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm">작게</Button>
                  <Button>기본</Button>
                  <Button size="lg">크게</Button>
                  <Button disabled>
                    <Spinner data-icon="inline-start" />
                    저장 중
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" aria-label="새로고침">
                        <RefreshCwIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      새로고침 <Kbd>R</Kbd>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </CardContent>
          </Card>
        </Section>

        <Section
          id="forms"
          title="폼"
          description="모든 입력에 보이는 라벨을 둔다. placeholder는 형식 안내에만 쓴다."
        >
          <Card>
            <CardContent>
              <FieldGroup>
                <div className="grid gap-6 md:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="name">접속 이름</FieldLabel>
                    <Input id="name" defaultValue="billing-oracle" />
                    <FieldDescription>목록과 알림에 표시됩니다.</FieldDescription>
                  </Field>
                  <Field data-invalid>
                    <FieldLabel htmlFor="cron">cron 표현식</FieldLabel>
                    <Input id="cron" aria-invalid defaultValue="0 0 25 * * ?" />
                    <FieldError>시(hour)는 0~23 사이여야 합니다.</FieldError>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="env">환경 라벨</FieldLabel>
                    <Select defaultValue="prod">
                      <SelectTrigger id="env">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="prod">prod</SelectItem>
                        <SelectItem value="stage">stage</SelectItem>
                        <SelectItem value="dev">dev</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="search">트리거 검색</FieldLabel>
                    <InputGroup>
                      <InputGroupInput id="search" placeholder="예: BILLING.*" />
                      <InputGroupAddon>
                        <SearchIcon aria-hidden />
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                </div>
                <Field orientation="horizontal">
                  <Switch id="auto-refresh" defaultChecked />
                  <FieldLabel htmlFor="auto-refresh">30초마다 자동 새로고침</FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox id="ack" />
                  <FieldLabel htmlFor="ack">영향 범위를 확인했습니다</FieldLabel>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        </Section>

        <Section
          id="table"
          title="표"
          description="목록 화면의 기본 형태. 키와 cron은 D2Coding, 시각은 tabular-nums."
        >
          <Card>
            <CardHeader>
              <CardTitle>트리거</CardTitle>
              <CardDescription>billing-cluster · 데이터 기준 2026-11-06 10:24:13</CardDescription>
              <CardAction>
                <EnvBadge environment="prod" />
              </CardAction>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>그룹.이름</TableHead>
                    <TableHead>스케줄</TableHead>
                    <TableHead>상태</TableHead>
                    <TableHead>다음 실행</TableHead>
                    <TableHead>
                      <span className="sr-only">작업</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SAMPLE_TRIGGERS.map((t) => (
                    <TableRow key={`${t.group}.${t.name}`}>
                      <TableCell>
                        <span className="font-mono">
                          {t.group}.{t.name}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono">{t.cron}</span>
                      </TableCell>
                      <TableCell>
                        <TriggerStateBadge state={t.state} />
                      </TableCell>
                      <TableCell>{t.next}</TableCell>
                      <TableCell className="text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t.state === 'PAUSED' ? '재개' : '일시정지'}
                            >
                              {t.state === 'PAUSED' ? <PlayIcon /> : <PauseIcon />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t.state === 'PAUSED' ? '재개' : '일시정지'}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Section>

        <Section
          id="feedback"
          title="피드백"
          description="경고 영역, 제어 결과 알림(토스트), 확인 대화상자, 로딩과 빈 상태."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Alert>
              <AlertTitle>재개됨</AlertTitle>
              <AlertDescription>
                지난 실행은 Quartz 노드가 misfire 정책에 따라 최대 1분 안에 처리합니다.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTitle>대상 DB에 연결하지 못했습니다</AlertTitle>
              <AlertDescription>
                10초 안에 응답이 없었습니다. 접속 정보를 확인하고 다시 시도하세요.
              </AlertDescription>
            </Alert>
          </div>
          <Card>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => toast.success('트리거를 일시정지했습니다.')}
                >
                  성공 토스트
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    toast.error('일시정지하지 못했습니다.', {
                      description: '화면에서 본 상태와 달라 중단했습니다. 최신 상태를 확인하세요.',
                    })
                  }
                >
                  실패 토스트
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive">삭제 확인 열기</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <ProdStripe environment="prod" name="billing-cluster" />
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        트리거 BILLING.monthly-invoice를 삭제할까요?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        삭제하면 되돌릴 수 없습니다. 감사 로그에 변경 전 값이 남습니다.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>취소</AlertDialogCancel>
                      <AlertDialogAction variant="destructive">트리거 삭제</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>로딩</CardTitle>
                <CardDescription>1초 넘게 걸리는 목록은 스켈레톤을 쓴다.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </CardContent>
            </Card>
            <div className="rounded-lg border">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <InboxIcon />
                  </EmptyMedia>
                  <EmptyTitle>등록된 스케줄러가 없습니다</EmptyTitle>
                  <EmptyDescription>
                    접속을 추가하면 Quartz 테이블을 자동으로 찾아 스케줄러를 등록합니다.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button>접속 추가</Button>
                </EmptyContent>
              </Empty>
            </div>
          </div>
        </Section>

        <Section id="tabs" title="탭" description="상세 화면의 하위 보기 전환.">
          <Tabs defaultValue="triggers">
            <TabsList>
              <TabsTrigger value="triggers">트리거</TabsTrigger>
              <TabsTrigger value="jobs">잡</TabsTrigger>
              <TabsTrigger value="nodes">
                노드 <Badge variant="neutral">3</Badge>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="triggers">
              <p className="text-sm text-muted-foreground">트리거 목록이 들어갑니다.</p>
            </TabsContent>
            <TabsContent value="jobs">
              <p className="text-sm text-muted-foreground">잡 목록이 들어갑니다.</p>
            </TabsContent>
            <TabsContent value="nodes">
              <p className="text-sm text-muted-foreground">클러스터 노드 목록이 들어갑니다.</p>
            </TabsContent>
          </Tabs>
        </Section>
      </main>
    </div>
  );
}
