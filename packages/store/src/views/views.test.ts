import { describe, expect, it } from 'vitest';
import type { BindValue, Row, TargetConn } from '../adapter.js';
import { oracleDialect } from '../oracle/dialect.js';
import { QUARTZ_REQUIRED_TABLES } from '../quartz-tables.js';
import { createTableSet } from '../table-set.js';
import { containsPattern } from './sql.js';
import {
  isActiveNode,
  listGroups,
  listJobs,
  listTriggers,
  type SchedulerViewContext,
} from './views.js';

const features = {
  simpropTriggers: true,
  triggerPriority: true,
  firedPriority: true,
  firedSchedTime: true,
  jobNonconcurrent: true,
  jobUpdateData: true,
  cronTimeZone: true,
};

const ctx: SchedulerViewContext = {
  dialect: oracleDialect,
  tables: createTableSet(oracleDialect, {
    schema: 'Q',
    tables: {
      ...Object.fromEntries(QUARTZ_REQUIRED_TABLES.map((t) => [t, `QRTZ_${t}`])),
      SIMPROP_TRIGGERS: 'QRTZ_SIMPROP_TRIGGERS',
    },
  }),
  features,
  schedName: 'S',
};

/** 실행한 SQL과 바인드를 기록한다. COUNT 쿼리에는 개수 행을 돌려준다 */
class RecordingConn implements TargetConn {
  readonly kind = 'oracle' as const;
  readonly inTransaction = false;
  readonly calls: { sql: string; binds: readonly BindValue[] }[] = [];
  /** COUNT가 아닌 쿼리에 돌려줄 행 */
  rows: Row[] = [];
  query<R extends Row = Row>(sql: string, binds: readonly BindValue[] = []): Promise<R[]> {
    this.calls.push({ sql, binds });
    return Promise.resolve(
      (sql.includes('COUNT(*) AS "CNT"') ? [{ CNT: 7 }] : this.rows) as unknown as R[],
    );
  }
  execute(): Promise<number> {
    return Promise.reject(new Error('조회는 쓰기를 하지 않는다'));
  }
  commit = () => Promise.resolve();
  rollback = () => Promise.resolve();
  close = () => Promise.resolve();
}

/** SQL의 바인드 자리 번호가 1..n으로 빠짐없이 쓰였는지 */
function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/:p(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

describe('containsPattern', () => {
  it('%, _, 이스케이프 문자를 글자 그대로 찾도록 감싼다', () => {
    expect(containsPattern('100%_done')).toBe('%100!%!_done%');
    expect(containsPattern('a!b')).toBe('%a!!b%');
    expect(containsPattern('grp/sub')).toBe('%grp/sub%');
  });
});

describe('isActiveNode', () => {
  it('마지막 체크인 + 간격 × 배수가 DB 시각 이상이면 활성', () => {
    expect(isActiveNode(1_000, 100, 1_300, 3)).toBe(true);
    expect(isActiveNode(1_000, 100, 1_301, 3)).toBe(false);
    expect(isActiveNode(null, 100, 0, 3)).toBe(false);
  });
});

describe('listTriggers SQL', () => {
  it('필터마다 바인드를 따로 쓰고, 페이지네이션 번호가 바인드 순서와 맞는다', async () => {
    const conn = new RecordingConn();
    const result = await listTriggers(conn, ctx, {
      state: ['WAITING', 'PAUSED'],
      type: ['CRON'],
      group: 'g%_/1',
      q: 'x_y',
      sort: 'nextFireTime',
      page: 3,
      size: 20,
    });
    expect(result.total).toBe(7);
    const [count, page] = conn.calls;
    expect(count!.binds).toEqual([
      'S',
      'WAITING',
      'PAUSED',
      'CRON',
      'g%_/1',
      '%x!_y%',
      '%x!_y%',
      '%x!_y%',
    ]);
    expect(placeholders(count!.sql)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 그룹은 LIKE가 아니라 정확히 일치로 비교한다
    expect(page!.sql).toContain('t.TRIGGER_GROUP = :p5');
    expect(page!.sql).toContain(`ESCAPE '!'`);
    expect(page!.sql).toMatch(/OFFSET :p10 ROWS FETCH NEXT :p9 ROWS ONLY$/);
    expect(page!.binds.slice(-2)).toEqual([20, 40]);
    expect(page!.sql).toContain('CASE WHEN t.NEXT_FIRE_TIME > 0 THEN 0 ELSE 1 END');
    expect(page!.sql).toContain('LEFT JOIN "Q"."QRTZ_SIMPROP_TRIGGERS" sp');
  });

  it('없는 선택 컬럼과 테이블은 넣지 않는다', async () => {
    const conn = new RecordingConn();
    await listTriggers(
      conn,
      {
        ...ctx,
        features: {
          ...features,
          simpropTriggers: false,
          triggerPriority: false,
          cronTimeZone: false,
        },
      },
      { sort: 'key', page: 1, size: 50 },
    );
    const sql = conn.calls[1]!.sql;
    expect(sql).not.toContain('SIMPROP');
    expect(sql).not.toContain('t.PRIORITY');
    expect(sql).not.toContain('TIME_ZONE_ID');
    expect(conn.calls[1]!.binds).toEqual(['S', 50, 0]);
  });
});

describe('listGroups SQL', () => {
  it('그룹을 이름순으로 limit + 1개 읽고, 넘으면 잘랐다고 알린다', async () => {
    const conn = new RecordingConn();
    conn.rows = [{ G: 'a' }, { G: 'b' }, { G: 'c' }];
    expect(await listGroups(conn, ctx, 'trigger', 2)).toEqual({
      items: ['a', 'b'],
      truncated: true,
    });
    expect(conn.calls[0]!.sql).toBe(
      'SELECT DISTINCT TRIGGER_GROUP AS "G" FROM "Q"."QRTZ_TRIGGERS" WHERE SCHED_NAME = :p1 ' +
        'ORDER BY TRIGGER_GROUP OFFSET :p3 ROWS FETCH NEXT :p2 ROWS ONLY',
    );
    expect(conn.calls[0]!.binds).toEqual(['S', 3, 0]);

    expect(await listGroups(conn, ctx, 'job', 3)).toEqual({
      items: ['a', 'b', 'c'],
      truncated: false,
    });
    expect(conn.calls[1]!.sql).toContain(
      'SELECT DISTINCT JOB_GROUP AS "G" FROM "Q"."QRTZ_JOB_DETAILS"',
    );
  });
});

describe('listJobs SQL', () => {
  it('검색어는 이름·그룹·클래스에 걸고 JOB_DATA는 읽지 않는다', async () => {
    const conn = new RecordingConn();
    await listJobs(conn, ctx, { q: '50%', page: 1, size: 10 });
    const sql = conn.calls[1]!.sql;
    expect(sql).not.toContain('JOB_DATA');
    expect(sql).toContain('UPPER(j.JOB_CLASS_NAME) LIKE UPPER(:p4)');
    expect(conn.calls[1]!.binds).toEqual(['S', '%50!%%', '%50!%%', '%50!%%', 10, 0]);
  });
});
