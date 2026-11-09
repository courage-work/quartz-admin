import type { Metadata } from 'next';

import { PageHeader } from '@/components/shell/page-header';

import { ConnectionForm } from '@/components/connections/connection-form';

export const metadata: Metadata = { title: '접속 추가' };

export default function NewConnectionPage() {
  return (
    <>
      <PageHeader
        trail={[{ label: '접속', href: '/connections' }]}
        title="접속 추가"
        description="저장하기 전에 연결 테스트로 접속 정보와 Quartz 테이블을 확인할 수 있습니다."
      />
      <ConnectionForm />
    </>
  );
}
