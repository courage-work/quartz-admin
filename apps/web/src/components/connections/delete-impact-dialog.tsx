'use client';

import type { DeleteImpactDto } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';

import { FormAlert } from '@/components/form/form-alert';
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
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

/**
 * 삭제 영향 미리보기와 확인 (FR-CON-05). 열릴 때 영향 범위를 새로 읽는다.
 * 메타데이터만 지우며 대상 DB의 Quartz 데이터는 건드리지 않는다.
 */
export function DeleteImpactDialog({
  open,
  title,
  impactPath,
  confirmLabel,
  description,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  impactPath: string;
  confirmLabel: string;
  description: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const impact = useQuery({
    queryKey: ['delete-impact', impactPath],
    queryFn: ({ signal }) => api<DeleteImpactDto>(impactPath, { signal }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {impact.isError ? <FormAlert message={impact.error.message} /> : null}
        {impact.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {impact.data ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>함께 지워지는 것:</p>
            <ul className="list-disc pl-5">
              <li>
                스케줄러 {impact.data.schedulers.length}개
                {impact.data.schedulers.length > 0
                  ? `: ${impact.data.schedulers.map((s) => s.displayName).join(', ')}`
                  : ''}
              </li>
              <li>알림 규칙 {impact.data.alertRuleCount}개</li>
              <li>열린 알림 {impact.data.openAlertCount}개</li>
            </ul>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>취소</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending || !impact.data}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
