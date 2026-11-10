import type { ConnectionDto, SchedulerSummaryDto } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import { QUICK_NAV_GROUP_MAX, quickNavGroups } from './quick-nav';

const scheduler = (id: number, displayName: string, connName: string, envLabel: string) =>
  ({
    id,
    displayName,
    schedName: `S${id}`,
    connection: { name: connName, envLabel },
  }) as unknown as SchedulerSummaryDto;

const connection = (
  id: number,
  name: string,
  host: string,
  envLabel: string,
  tags: string[] = [],
) => ({ id, name, host, envLabel, tags }) as unknown as ConnectionDto;

const schedulers = [
  scheduler(2, '주문 스케줄러', '주문 운영 DB', 'prod'),
  scheduler(1, '정산 배치', '정산 DB', 'dev'),
];
const connections = [
  connection(2, '주문 운영 DB', 'db-order', 'prod', ['결제']),
  connection(1, '정산 DB', 'db-settle', 'dev'),
];

describe('quickNavGroups', () => {
  it('검색어가 없으면 화면·스케줄러·접속을 이름순으로 모두 보인다', () => {
    const groups = quickNavGroups({ q: '', isAdmin: true, schedulers, connections });
    expect(groups.map((g) => g.title)).toEqual(['화면', '스케줄러', '접속']);
    expect(groups[1]!.items.map((i) => [i.label, i.href, i.envLabel])).toEqual([
      ['정산 배치', '/scheduler?id=1', 'dev'],
      ['주문 스케줄러', '/scheduler?id=2', 'prod'],
    ]);
    expect(groups[2]!.items.map((i) => i.href)).toEqual(['/connection?id=1', '/connection?id=2']);
  });

  it('관리자가 아니면 사용자 화면을 보이지 않는다', () => {
    const labels = (isAdmin: boolean) =>
      quickNavGroups({ q: '', isAdmin, schedulers: [], connections: [] })[0]!.items.map(
        (i) => i.label,
      );
    expect(labels(true)).toContain('사용자');
    expect(labels(false)).not.toContain('사용자');
  });

  it('이름, 접속 이름, 환경, 태그, 영문 별칭으로 찾고 빈 묶음은 뺀다', () => {
    const find = (q: string) =>
      quickNavGroups({ q, isAdmin: true, schedulers, connections }).map((g) => [
        g.title,
        g.items.map((i) => i.label),
      ]);
    expect(find('prod')).toEqual([
      ['스케줄러', ['주문 스케줄러']],
      ['접속', ['주문 운영 DB']],
    ]);
    expect(find('결제')).toEqual([['접속', ['주문 운영 DB']]]);
    expect(find('AUDIT')).toEqual([['화면', ['감사 로그']]]);
    expect(find('없는 이름')).toEqual([]);
  });

  it(`묶음마다 ${QUICK_NAV_GROUP_MAX}개까지만 보인다`, () => {
    const many = Array.from({ length: 30 }, (_, i) => scheduler(i + 1, `s-${i}`, 'c', 'dev'));
    const groups = quickNavGroups({ q: 's-', isAdmin: true, schedulers: many, connections: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(QUICK_NAV_GROUP_MAX);
  });
});
