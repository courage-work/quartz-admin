import { LayoutDashboardIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

export const metadata: Metadata = { title: '대시보드' };

/** 대시보드 자리. 스케줄러 카드와 표는 B-16에서 채운다 */
export default function DashboardPage() {
  return (
    <>
      <PageHeader title="대시보드" description="등록한 Quartz 스케줄러의 상태를 한눈에 봅니다." />
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboardIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>아직 등록한 스케줄러가 없습니다</EmptyTitle>
          <EmptyDescription>
            접속·스케줄러 등록 기능을 준비하고 있습니다. 그동안 감사 로그에서 로그인과 사용자 변경
            기록을 확인할 수 있습니다.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link href="/audit-logs">감사 로그 보기</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}
