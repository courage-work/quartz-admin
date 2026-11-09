import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { TableCell, TableRow } from '@/components/ui/table';

/**
 * 표 안의 "데이터 없음" 줄 (B-40). 모든 목록 표가 이 모양을 쓴다: 표 폭 가운데에 아이콘·제목·설명,
 * 지울 수 있으면 지우기 버튼.
 *
 * - 아무것도 없을 때: 그 표의 대상 아이콘(사용자, 잡 등)과 "아직 …가 없습니다"
 * - 검색·필터 결과가 없을 때: `SearchXIcon`과 "조건에 맞는 …가 없습니다" + 지우기 버튼
 */
export function TableEmpty({
  colSpan,
  icon: Icon,
  title,
  description,
  action,
}: {
  colSpan: number;
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        {/* 표 칸은 줄바꿈을 막으므로(whitespace-nowrap) 설명이 길면 줄바꿈되게 되돌린다.
            넓은 표가 가로로 스크롤돼도 보이는 폭 가운데에 오게 고정한다(globals.css) */}
        <div className="empty-fit-frame whitespace-normal">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{title}</EmptyTitle>
              {description ? <EmptyDescription>{description}</EmptyDescription> : null}
            </EmptyHeader>
            {action ? <EmptyContent>{action}</EmptyContent> : null}
          </Empty>
        </div>
      </TableCell>
    </TableRow>
  );
}
