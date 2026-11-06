import type { ConnectionDto } from '@qa/shared';
import { CircleCheckIcon, CircleDashedIcon, EyeIcon, TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { writeStatus } from '@/lib/connections';

const ICONS = {
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  neutral: EyeIcon,
} as const;

/** 쓰기 권한 표시 (FR-CON-04). 색만으로 구분하지 않도록 아이콘과 라벨을 함께 쓴다 */
export function WriteStatusBadge({
  connection,
}: {
  connection: Pick<ConnectionDto, 'readOnly' | 'writeCapable'>;
}) {
  const status = writeStatus(connection);
  const Icon =
    connection.writeCapable === null && !connection.readOnly
      ? CircleDashedIcon
      : ICONS[status.tone];
  return (
    <Badge variant={status.tone}>
      <Icon data-icon="inline-start" aria-hidden />
      {status.label}
    </Badge>
  );
}
