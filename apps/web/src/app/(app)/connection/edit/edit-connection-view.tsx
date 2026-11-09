'use client';

import type { ConnectionDto } from '@qa/shared';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';

import { ConnectionForm } from '@/components/connections/connection-form';
import { ConnectionNotFound } from '@/components/connections/connection-not-found';
import { FormAlert } from '@/components/form/form-alert';
import { PageHeader } from '@/components/shell/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { api, isApiError } from '@/lib/api';
import { connectionKey } from '@/lib/connections';
import { parseId } from '@/lib/navigation';

/** 접속 수정 (`/connection/edit?id=N`, FR-CON-05) */
export function EditConnectionView() {
  const id = parseId(useSearchParams().get('id'));
  const connection = useQuery({
    queryKey: connectionKey(id ?? 0),
    queryFn: ({ signal }) => api<ConnectionDto>(`/connections/${id}`, { signal }),
    enabled: id !== null,
  });

  let body;
  if (id === null || isApiError(connection.error, 'NOT_FOUND')) body = <ConnectionNotFound />;
  else if (connection.isError) body = <FormAlert error={connection.error} />;
  else if (connection.isPending) body = <Skeleton className="h-96 w-full max-w-3xl" />;
  // 값을 다 받은 뒤에 폼을 만든다(react-hook-form 기본값은 처음 한 번만 쓰인다)
  else body = <ConnectionForm key={connection.data.updatedAt} connection={connection.data} />;

  return (
    <>
      <PageHeader
        trail={[
          { label: '접속', href: '/connections' },
          ...(id !== null
            ? [{ label: connection.data?.name ?? '접속', href: `/connection?id=${id}` }]
            : []),
        ]}
        title="접속 수정"
        description="비밀번호를 비워 두면 저장된 비밀번호를 그대로 씁니다."
      />
      {body}
    </>
  );
}
