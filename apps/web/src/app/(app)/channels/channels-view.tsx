'use client';

import type { ChannelDto, ChannelsResponse, ChannelTestResult } from '@qa/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { FormAlert } from '@/components/form/form-alert';
import { PageHeader } from '@/components/shell/page-header';
import { TableFrame } from '@/components/table-frame';
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
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import {
  CHANNEL_TYPE_LABELS,
  CHANNELS_KEY,
  describeChannelTarget,
  describeLastDelivery,
} from '@/lib/channels';
import { usePageTitle } from '@/lib/page-title';

function ChannelMenu({
  channel,
  onTest,
  onDelete,
  testing,
}: {
  channel: ChannelDto;
  onTest: (c: ChannelDto) => void;
  onDelete: (c: ChannelDto) => void;
  testing: boolean;
}) {
  const label = `${channel.name} 채널 메뉴`;
  const editable = channel.type !== 'inapp';
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={label}>
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {editable ? null : (
          <>
            <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
              인앱 채널은 도구가 만든 채널이라 바꾸거나 지울 수 없습니다.
            </p>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          disabled={!editable || testing || !channel.enabled}
          onSelect={() => onTest(channel)}
        >
          <SendIcon aria-hidden />
          테스트 발송
        </DropdownMenuItem>
        {editable ? (
          <DropdownMenuItem asChild>
            <Link href={`/channel/edit?id=${channel.id}`}>
              <PencilIcon aria-hidden />
              수정
            </Link>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>
            <PencilIcon aria-hidden />
            수정
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={!editable}
          onSelect={() => onDelete(channel)}
        >
          <Trash2Icon aria-hidden />
          삭제
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 알림 채널 (`/channels`, FR-ALT-07). 인앱 채널은 하나뿐이고 도구가 만든다. Slack·이메일 채널은 추가해 규칙에 연결한다.
 * 채널마다 테스트 발송으로 설정을 확인한다.
 */
export function ChannelsView() {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<ChannelDto | null>(null);
  usePageTitle('알림 채널');
  const res = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: ({ signal }) => api<ChannelsResponse>('/channels', { signal }),
  });
  const test = useMutation({
    mutationFn: (c: ChannelDto) =>
      api<ChannelTestResult>(`/channels/${c.id}/test`, { method: 'POST' }),
    onSuccess: (r, c) => {
      if (r.ok) toast.success(`${c.name}: ${r.message}`);
      else toast.error(`${c.name}(으)로 보내지 못했습니다: ${r.message}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const remove = useMutation({
    mutationFn: (c: ChannelDto) => api<void>(`/channels/${c.id}`, { method: 'DELETE' }),
    onSuccess: (_, c) => {
      toast.success(`${c.name} 채널을 삭제했습니다`);
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });
  const channels = res.data?.channels;
  const emailWithoutSmtp =
    res.data && !res.data.smtpConfigured && res.data.channels.some((c) => c.type === 'email');

  return (
    <>
      <PageHeader
        title="알림 채널"
        description="알림을 보낼 곳입니다. 어느 알림을 어디로 보낼지는 스케줄러의 알림 규칙에서 고릅니다."
        actions={
          <Button asChild>
            <Link href="/channels/new">
              <PlusIcon data-icon="inline-start" aria-hidden />
              채널 추가하기
            </Link>
          </Button>
        }
      />
      {res.isError ? <FormAlert error={res.error} /> : null}
      {emailWithoutSmtp ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>SMTP를 설정하지 않아 이메일 채널로 보낼 수 없습니다</AlertTitle>
          <AlertDescription>서버에 QA_SMTP_HOST와 QA_SMTP_FROM을 설정하세요.</AlertDescription>
        </Alert>
      ) : null}
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>이름 / 종류</TableHead>
              <TableHead>보낼 곳</TableHead>
              <TableHead>연결된 규칙</TableHead>
              <TableHead>마지막 발송</TableHead>
              <TableHead>사용</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">메뉴</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!channels
              ? Array.from({ length: 2 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : channels.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span>{c.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {CHANNEL_TYPE_LABELS[c.type]}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="max-w-72">
                      <span
                        className={`block truncate ${c.type === 'slack' ? 'font-mono' : ''}`}
                        title={describeChannelTarget(c)}
                      >
                        {describeChannelTarget(c)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="tabular-nums">{c.ruleCount}개</span>
                    </TableCell>
                    <TableCell className="max-w-64">
                      <span className="block truncate" title={describeLastDelivery(c)}>
                        {c.lastDelivery && !c.lastDelivery.ok ? (
                          <span className="text-destructive">{describeLastDelivery(c)}</span>
                        ) : (
                          describeLastDelivery(c)
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      {c.enabled ? (
                        <Badge variant="success">켜짐</Badge>
                      ) : (
                        <Badge variant="neutral">꺼짐</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <ChannelMenu
                        channel={c}
                        testing={test.isPending}
                        onTest={(x) => test.mutate(x)}
                        onDelete={setDeleting}
                      />
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </TableFrame>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting ? `${deleting.name} 채널을 삭제할까요?` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleting.ruleCount > 0
                ? `이 채널에 연결된 규칙 ${deleting.ruleCount}개는 이제 여기로 보내지 않습니다. `
                : ''}
              발송 기록도 함께 지워집니다. 잠시 멈추려면 삭제 대신 사용을 끄세요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>취소</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) remove.mutate(deleting);
              }}
            >
              {deleting ? `${deleting.name} 삭제하기` : '삭제하기'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
