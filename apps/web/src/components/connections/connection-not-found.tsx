import { SearchXIcon } from 'lucide-react';
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

export function ConnectionNotFound() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>접속을 찾을 수 없습니다</EmptyTitle>
        <EmptyDescription>주소가 잘못됐거나 이미 삭제된 접속입니다.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href="/connections">접속 목록으로 가기</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
