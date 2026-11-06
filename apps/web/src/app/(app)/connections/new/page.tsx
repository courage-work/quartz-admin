import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

import { ConnectionForm } from '@/components/connections/connection-form';

export const metadata: Metadata = { title: '접속 추가' };

export default function NewConnectionPage() {
  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/connections">접속</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>접속 추가</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageHeader
        title="접속 추가"
        description="저장하기 전에 연결 테스트로 접속 정보와 Quartz 테이블을 확인할 수 있습니다."
      />
      <ConnectionForm />
    </>
  );
}
