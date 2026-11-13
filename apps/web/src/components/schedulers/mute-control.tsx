'use client';

import { MUTE_MAX_MS, type SchedulerMuteDto } from '@qa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellOffIcon, BellRingIcon, CalendarClockIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { MUTE_PRESETS, formatMuteUntil, parseMuteUntil, toLocalInputValue } from '@/lib/mute';
import { DASHBOARD_KEY, schedulerKey } from '@/lib/schedulers';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 처음 그릴 때의 시각. 끝나는 시각을 "오늘이면 시:분"으로 줄여 쓰는 데만 쓴다 */
export function useMountTime(): number {
  const [now] = useState(() => Date.now());
  return now;
}

/** 스케줄러 머리글의 음소거 배지. 음소거 중일 때만 보인다 (FR-ALT-10) */
export function MuteBadge({ mutedUntil }: { mutedUntil: number | null }) {
  const now = useMountTime();
  if (mutedUntil === null) return null;
  return (
    <Badge variant="neutral">
      <BellOffIcon aria-hidden />
      알림 음소거 ~ {formatMuteUntil(mutedUntil, now)}
    </Badge>
  );
}

/**
 * 알림 음소거 메뉴 (FR-ALT-10). 기간을 고르면 바로 음소거하고, 음소거 중이면 해제할 수 있다.
 * 되돌리기 쉬운 설정이라 확인 대화상자 없이 알림으로 결과를 알린다. 상태는 계속 기록하고 발송만 멈춘다.
 */
export function MuteMenu({
  schedulerId,
  mutedUntil,
}: {
  schedulerId: number;
  mutedUntil: number | null;
}) {
  const queryClient = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [custom, setCustom] = useState(false);
  const now = useMountTime();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: schedulerKey(schedulerId) });
    void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
  };
  const mute = useMutation({
    mutationFn: (until: number) =>
      api<SchedulerMuteDto>(`/schedulers/${schedulerId}/mute`, {
        method: 'PUT',
        body: { until },
      }),
    onSuccess: (res) => {
      if (res.mutedUntil !== null) {
        toast.success(
          `알림을 ${formatMuteUntil(res.mutedUntil, Date.now())}까지 음소거했습니다. 상태는 계속 기록합니다`,
        );
      }
      setCustom(false);
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const unmute = useMutation({
    mutationFn: () =>
      api<SchedulerMuteDto>(`/schedulers/${schedulerId}/mute`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('알림 음소거를 해제했습니다. 열려 있는 알림은 다음 감시 회차에 보냅니다');
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const label = mutedUntil === null ? '알림 음소거' : '알림 음소거 중';

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={button}
                variant="outline"
                size="icon"
                aria-label={label}
                disabled={mute.isPending || unmute.isPending}
              >
                {mutedUntil === null ? <BellRingIcon aria-hidden /> : <BellOffIcon aria-hidden />}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
            {mutedUntil === null
              ? '점검 중에 알림을 보내지 않습니다. 상태는 계속 기록하고, 끝난 뒤 열려 있는 알림을 보냅니다'
              : `${formatMuteUntil(mutedUntil, now)}까지 음소거 중입니다`}
          </p>
          <DropdownMenuSeparator />
          {MUTE_PRESETS.map((p) => (
            <DropdownMenuItem key={p.ms} onSelect={() => mute.mutate(Date.now() + p.ms)}>
              <BellOffIcon aria-hidden />
              {p.label} 음소거
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setCustom(true)}>
            <CalendarClockIcon aria-hidden />
            끝나는 시각 지정…
          </DropdownMenuItem>
          {mutedUntil !== null ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => unmute.mutate()}>
                <BellRingIcon aria-hidden />
                음소거 해제
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {custom ? (
        <CustomMuteDialog
          initial={mutedUntil}
          pending={mute.isPending}
          onSubmit={(until) => mute.mutate(until)}
          onClose={() => {
            setCustom(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

/** 끝나는 시각을 직접 고르는 대화상자. 제출할 때 검사하고, 고치면 오류를 지운다 */
function CustomMuteDialog({
  initial,
  pending,
  onSubmit,
  onClose,
}: {
  /** 음소거 중이면 지금 끝나는 시각. 아니면 1시간 뒤로 채운다 */
  initial: number | null;
  pending: boolean;
  onSubmit: (until: number) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(() => toLocalInputValue(initial ?? Date.now() + 60 * 60_000));
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const submit = () => {
    const parsed = parseMuteUntil(value, Date.now());
    if (parsed.error !== undefined) setError(parsed.error);
    else onSubmit(parsed.until);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>알림 음소거</DialogTitle>
          <DialogDescription>
            고른 시각까지 이 스케줄러의 알림을 보내지 않습니다. 상태는 계속 기록하고, 끝난 뒤 열려
            있는 알림을 보냅니다.
          </DialogDescription>
        </DialogHeader>
        {/* 브라우저 기본 검사(min·max 말풍선) 대신 같은 규칙의 문구를 입력 칸 아래에 보여 준다 */}
        <form
          id={`${id}-form`}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={id}>끝나는 시각</FieldLabel>
            <Input
              id={id}
              type="datetime-local"
              value={value}
              min={toLocalInputValue(now)}
              max={toLocalInputValue(now + MUTE_MAX_MS)}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            {error ? <FieldError>{error}</FieldError> : null}
            <FieldDescription>브라우저 시간대 기준, 7일 안으로 고르세요.</FieldDescription>
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
            음소거하기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
