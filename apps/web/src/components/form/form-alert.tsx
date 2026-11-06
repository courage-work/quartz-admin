import { CircleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';

/** 특정 입력에 붙일 수 없는 폼 오류(`root`) */
export function FormAlert({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
