'use client';

import { CircleAlertIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';

/**
 * 특정 입력에 붙일 수 없는 오류(폼 `root`, 화면 데이터 조회 실패).
 * 서버·네트워크 문제면 지원 문의용 "오류 정보 복사"를 함께 둔다 (VectorLab errors).
 */
export function FormAlert({ message, error }: { message?: string; error?: unknown }) {
  const text = message ?? (error instanceof Error ? error.message : undefined);
  if (!text) return null;
  const technical = error instanceof ApiRequestError && error.isTechnical ? error : null;
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden />
      <AlertDescription>
        <span className="flex flex-col items-start gap-2">
          {text}
          {technical ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(technical.supportText()).then(
                  () => toast.success('오류 정보를 복사했습니다. 관리자에게 전달하세요'),
                  () => toast.error('복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하세요'),
                )
              }
            >
              <CopyIcon data-icon="inline-start" aria-hidden />
              오류 정보 복사
            </Button>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}
