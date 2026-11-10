'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type SchedulerDetailDto,
  type SchedulerDto,
  type SchedulerSettings,
  schedulerSettingsSchema,
} from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { FormActions } from '@/components/form/form-actions';
import { FormAlert } from '@/components/form/form-alert';
import { FormRows } from '@/components/form/form-row';
import { TextField } from '@/components/form/text-field';
import { PageHeader } from '@/components/shell/page-header';
import { EnvBadge, ProdStripe } from '@/components/status/environment';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { api, isApiError } from '@/lib/api';
import { CONNECTIONS_KEY } from '@/lib/connections';
import { applyApiError } from '@/lib/form-errors';
import { parseId } from '@/lib/navigation';
import { usePageTitle } from '@/lib/page-title';
import { schedulerKey } from '@/lib/schedulers';

type FormInput = z.input<typeof schedulerSettingsSchema>;

const FIELDS: (keyof SchedulerSettings)[] = [
  'displayName',
  'misfireThresholdMs',
  'overdueGraceMs',
  'checkinMultiplier',
  'expectedNodeCount',
  'pollIntervalSec',
];

function SettingsForm({
  scheduler,
  back,
}: {
  scheduler: SchedulerDetailDto;
  /** 저장·취소 뒤 돌아갈 화면(들어온 곳) */
  back: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useForm<FormInput, unknown, SchedulerSettings>({
    mode: 'onSubmit',
    resolver: zodResolver(schedulerSettingsSchema),
    defaultValues: {
      displayName: scheduler.displayName,
      misfireThresholdMs: scheduler.misfireThresholdMs,
      overdueGraceMs: scheduler.overdueGraceMs,
      checkinMultiplier: scheduler.checkinMultiplier,
      expectedNodeCount: scheduler.expectedNodeCount,
      pollIntervalSec: scheduler.pollIntervalSec,
    },
  });
  const save = useMutation({
    mutationFn: (body: SchedulerSettings) =>
      api<SchedulerDto>(`/schedulers/${scheduler.id}/settings`, { method: 'PUT', body }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: schedulerKey(saved.id) });
      toast.success(`${saved.displayName} 설정을 저장했습니다`);
      router.push(back);
    },
    onError: (err) => applyApiError(err, form.setError, {}, FIELDS),
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => void form.handleSubmit((v) => save.mutate(v))(e)}
    >
      <FormAlert message={form.formState.errors.root?.message} />
      {/* 접속 수정 화면과 같은 카드·라벨 칸(1/4) 구성 (B-40) */}
      <Card>
        <CardHeader>
          <CardTitle>표시</CardTitle>
        </CardHeader>
        <CardContent>
          <FormRows>
            <TextField
              form={form}
              name="displayName"
              label="표시 이름"
              autoComplete="off"
              description="대시보드와 알림에 보이는 이름입니다."
              layout="row"
            />
          </FormRows>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>감시 기준</CardTitle>
          <CardDescription>대상 DB에는 아무것도 바꾸지 않습니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <FormRows>
            <TextField
              form={form}
              name="misfireThresholdMs"
              label="misfire 임계값(ms)"
              autoComplete="off"
              description="Quartz org.quartz.jobStore.misfireThreshold와 같게 둡니다. 기본 60000"
              layout="row"
              size="short"
            />
            <TextField
              form={form}
              name="overdueGraceMs"
              label="연체 유예 시간(ms)"
              autoComplete="off"
              description="misfire 임계값 이상이어야 합니다. 기본 60000"
              layout="row"
              size="short"
            />
            <TextField
              form={form}
              name="checkinMultiplier"
              label="체크인 판정 배수"
              autoComplete="off"
              description="체크인 간격 × 배수가 지나면 노드를 이탈로 봅니다. 기본 3"
              layout="row"
              size="short"
            />
            <TextField
              form={form}
              name="expectedNodeCount"
              label="기대 노드 수"
              autoComplete="off"
              description="활성 노드가 이보다 적으면 알립니다"
              layout="row"
              size="short"
            />
            <TextField
              form={form}
              name="pollIntervalSec"
              label="감시 주기(초)"
              autoComplete="off"
              description="15~3600초. 기본 60"
              layout="row"
              size="short"
            />
          </FormRows>
        </CardContent>
      </Card>
      <FormActions>
        <Button asChild variant="outline">
          <Link href={back}>취소</Link>
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
          설정 저장하기
        </Button>
      </FormActions>
    </form>
  );
}

/**
 * 스케줄러 감시 설정 (`/scheduler/settings?id=N`, FR-CON-07). 입력이 여섯 개라 대화상자 대신
 * 화면으로 둔다(VectorLab surfaces). 대상 DB에는 아무것도 바꾸지 않는다.
 */
export function SchedulerSettingsView() {
  const params = useSearchParams();
  const id = parseId(params.get('id'));
  const detail = useQuery({
    queryKey: schedulerKey(id ?? 0),
    queryFn: ({ signal }) => api<SchedulerDetailDto>(`/schedulers/${id}`, { signal }),
    enabled: id !== null,
  });

  // 스케줄러 상세에서 들어왔으면(`from=scheduler`) 경로와 돌아갈 곳을 그 화면으로 둔다. 기본은 접속 상세다
  const fromScheduler = params.get('from') === 'scheduler';
  usePageTitle(detail.data ? `${detail.data.displayName} 설정` : undefined);

  // 아직 못 읽었거나 읽지 못했어도 화면 머리(경로, 돌아가기)는 남긴다
  if (detail.isError || detail.isPending) {
    return (
      <>
        <PageHeader trail={[{ label: '접속', href: '/connections' }]} title="스케줄러 설정" />
        {id === null || isApiError(detail.error, 'NOT_FOUND') ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>스케줄러를 찾을 수 없습니다</EmptyTitle>
              <EmptyDescription>주소가 잘못됐거나 등록을 해제한 스케줄러입니다.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild variant="outline">
                <Link href="/connections">접속 목록으로 가기</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : detail.isError ? (
          <FormAlert error={detail.error} />
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </>
    );
  }
  const s = detail.data;

  return (
    <>
      <ProdStripe environment={s.connection.envLabel} name={s.displayName} />
      <PageHeader
        trail={
          fromScheduler
            ? [
                { label: '대시보드', href: '/' },
                { label: s.displayName, href: `/scheduler?id=${s.id}` },
              ]
            : [
                { label: '접속', href: '/connections' },
                { label: s.connection.name, href: `/connection?id=${s.connectionId}` },
              ]
        }
        title={`${s.displayName} 설정`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <EnvBadge environment={s.connection.envLabel} />
            <span className="font-mono">{s.schedName}</span>
          </span>
        }
      />
      <SettingsForm
        key={s.id}
        scheduler={s}
        back={fromScheduler ? `/scheduler?id=${s.id}` : `/connection?id=${s.connectionId}`}
      />
    </>
  );
}
