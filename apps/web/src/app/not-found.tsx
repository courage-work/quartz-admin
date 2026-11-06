import { CompassIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

export const metadata: Metadata = { title: '페이지를 찾을 수 없음' };

/** 없는 경로. 정적 export에서 404.html이 되고, API 서버가 없는 경로에 이 파일을 돌려준다 */
export default function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CompassIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>페이지를 찾을 수 없습니다</EmptyTitle>
          <EmptyDescription>주소가 바뀌었거나 없는 화면입니다.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href="/">대시보드로 가기</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}
