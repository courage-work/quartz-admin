'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type SchedulerDto, type SchedulerSettings, schedulerSettingsSchema } from '@qa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';

import { FormAlert } from '@/components/form/form-alert';
import { TextField } from '@/components/form/text-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { api } from '@/lib/api';
import { CONNECTIONS_KEY } from '@/lib/connections';
import { applyApiError } from '@/lib/form-errors';

type FormInput = z.input<typeof schedulerSettingsSchema>;

const FIELDS: (keyof SchedulerSettings)[] = [
  'displayName',
  'misfireThresholdMs',
  'overdueGraceMs',
  'checkinMultiplier',
  'expectedNodeCount',
  'pollIntervalSec',
];

function SettingsForm({ scheduler, onClose }: { scheduler: SchedulerDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<FormInput, unknown, SchedulerSettings>({
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
      toast.success(`${saved.displayName} 설정을 저장했습니다`);
      onClose();
    },
    onError: (err) => applyApiError(err, form.setError, {}, FIELDS),
  });

  return (
    <form noValidate onSubmit={(e) => void form.handleSubmit((v) => save.mutate(v))(e)}>
      <FieldGroup>
        <DialogHeader>
          <DialogTitle>스케줄러 설정</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{scheduler.schedName}</span> 감시 파라미터입니다. 대상
            DB에는 아무것도 바꾸지 않습니다.
          </DialogDescription>
        </DialogHeader>
        <FormAlert message={form.formState.errors.root?.message} />
        <TextField form={form} name="displayName" label="표시 이름" autoComplete="off" />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            form={form}
            name="misfireThresholdMs"
            label="misfire 임계값(ms)"
            autoComplete="off"
            description="Quartz org.quartz.jobStore.misfireThreshold와 같게 둡니다. 기본 60000"
          />
          <TextField
            form={form}
            name="overdueGraceMs"
            label="연체 유예 시간(ms)"
            autoComplete="off"
            description="misfire 임계값 이상이어야 합니다. 기본 60000"
          />
          <TextField
            form={form}
            name="checkinMultiplier"
            label="체크인 판정 배수"
            autoComplete="off"
            description="체크인 간격 × 배수가 지나면 노드를 이탈로 봅니다. 기본 3"
          />
          <TextField
            form={form}
            name="expectedNodeCount"
            label="기대 노드 수"
            autoComplete="off"
            description="활성 노드가 이보다 적으면 알립니다. 등록할 때 감지한 활성 노드 수로 시작합니다"
          />
          <TextField
            form={form}
            name="pollIntervalSec"
            label="감시 주기(초)"
            autoComplete="off"
            description="15~3600초. 기본 60"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" disabled={save.isPending}>
            설정 저장하기
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** 스케줄러 감시 설정 (FR-CON-07) */
export function SchedulerSettingsDialog({
  scheduler,
  onClose,
}: {
  scheduler: SchedulerDto | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={scheduler !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {scheduler ? (
          <SettingsForm key={scheduler.id} scheduler={scheduler} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
