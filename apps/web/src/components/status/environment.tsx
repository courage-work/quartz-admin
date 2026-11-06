import { ShieldAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

/** 운영 환경 라벨. 확인 절차는 환경과 관계없이 같고(PRD §4), 표시만 구분한다(NFR-UX-02). */
export const PROD_ENVIRONMENT = 'prod';

export function isProd(environment: string): boolean {
  return environment.toLowerCase() === PROD_ENVIRONMENT;
}

/** 목록·카드에 붙이는 환경 배지. prod는 채운 빨강, stage는 호박, 나머지는 회색. */
export function EnvBadge({ environment }: { environment: string }) {
  if (isProd(environment)) {
    return (
      <Badge variant="prod">
        <ShieldAlertIcon data-icon="inline-start" aria-hidden />
        {environment}
      </Badge>
    );
  }
  return (
    <Badge variant={environment.toLowerCase() === 'stage' ? 'warning' : 'neutral'}>
      {environment}
    </Badge>
  );
}

/**
 * prod 스케줄러 상세 화면과 제어 확인 대화상자 맨 위에 두는 빨간 띠.
 * prod가 아니면 아무것도 그리지 않는다.
 */
export function ProdStripe({ environment, name }: { environment: string; name?: string }) {
  if (!isProd(environment)) return null;
  return (
    <div
      role="note"
      className="flex items-center gap-2 bg-destructive px-4 py-1 text-xs font-semibold text-destructive-foreground"
    >
      <ShieldAlertIcon className="size-3.5" aria-hidden />
      운영(prod) 환경{name ? ` · ${name}` : ''}
    </div>
  );
}
