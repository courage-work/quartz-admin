import { Injectable } from '@nestjs/common';
import type {
  ExecutingResponse,
  JobDetailResponse,
  JobDto,
  JobKeyQuery,
  JobListQuery,
  NodesResponse,
  Page,
  PausedGroupsResponse,
  TriggerDto,
  TriggerListQuery,
} from '@qa/shared';
import {
  ALL_GROUPS_PAUSED,
  TargetError,
  createTableSet,
  dialectFor,
  getJobDetail,
  listExecuting,
  listJobs,
  listNodes,
  listPausedGroups,
  listTriggers,
  queryDbNowMillis,
  type SchedulerViewContext,
  type TargetConn,
} from '@qa/store';
import { notFound } from '../common/api-error.js';
import { ConnectionsService, type SchedulerRow } from '../connections/connections.service.js';
import { TargetsService } from '../targets/targets.service.js';
import { describeJobData } from './job-data.js';

interface ViewScope {
  conn: TargetConn;
  ctx: SchedulerViewContext;
  scheduler: SchedulerRow;
  dbNow: number;
}

/**
 * 스케줄러 조회 (TRD §8.1, PRD FR-VIEW-02~05, 08). 대상 DB에서 바로 읽고 응답마다 `dbNow`를 붙인다.
 * 같은 커넥션에서 DB 현재 시각을 먼저 읽어, 화면이 데이터 기준 시각을 표시하게 한다(FR-VIEW-06).
 */
@Injectable()
export class SchedulerViewsService {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly targets: TargetsService,
  ) {}

  nodes(id: number): Promise<NodesResponse> {
    return this.withScheduler(id, async ({ conn, ctx, scheduler, dbNow }) => ({
      dbNow,
      checkinMultiplier: scheduler.checkinMultiplier,
      nodes: await listNodes(conn, ctx, { dbNow, checkinMultiplier: scheduler.checkinMultiplier }),
    }));
  }

  pausedGroups(id: number): Promise<PausedGroupsResponse> {
    return this.withScheduler(id, async ({ conn, ctx, dbNow }) => {
      const groups = await listPausedGroups(conn, ctx);
      return {
        dbNow,
        groups: groups.filter((g) => g !== ALL_GROUPS_PAUSED),
        allPaused: groups.includes(ALL_GROUPS_PAUSED),
      };
    });
  }

  jobs(id: number, query: JobListQuery): Promise<Page<JobDto>> {
    return this.withScheduler(id, async ({ conn, ctx, dbNow }) => ({
      dbNow,
      ...(await listJobs(conn, ctx, query)),
      page: query.page,
      size: query.size,
    }));
  }

  jobDetail(id: number, key: JobKeyQuery): Promise<JobDetailResponse> {
    return this.withScheduler(id, async ({ conn, ctx, dbNow }) => {
      const detail = await getJobDetail(conn, ctx, key);
      if (!detail) throw notFound('잡을 찾을 수 없습니다');
      return {
        dbNow,
        job: detail.job,
        triggers: detail.triggers,
        jobData: describeJobData(detail.jobData),
      };
    });
  }

  triggers(id: number, query: TriggerListQuery): Promise<Page<TriggerDto>> {
    return this.withScheduler(id, async ({ conn, ctx, dbNow }) => ({
      dbNow,
      ...(await listTriggers(conn, ctx, query)),
      page: query.page,
      size: query.size,
    }));
  }

  executing(id: number): Promise<ExecutingResponse> {
    return this.withScheduler(id, async ({ conn, ctx, scheduler, dbNow }) => ({
      dbNow,
      items: await listExecuting(conn, ctx, {
        dbNow,
        checkinMultiplier: scheduler.checkinMultiplier,
      }),
    }));
  }

  /** 스케줄러와 접속을 찾아 커넥션 하나로 조회를 실행한다 */
  private async withScheduler<T>(id: number, fn: (scope: ViewScope) => Promise<T>): Promise<T> {
    const scheduler = this.connections.requireScheduler(id);
    const connection = this.connections.require(scheduler.connectionId);
    const dialect = dialectFor(connection.dbType);
    if (!dialect) {
      throw new TargetError('TARGET_ERROR', {
        message: `아직 지원하지 않는 DB 종류입니다: ${connection.dbType}`,
      });
    }
    const ctx: SchedulerViewContext = {
      dialect,
      // 0001 마이그레이션 전에 등록한 스케줄러는 감지 스키마가 없어 접속의 스키마 설정을 쓴다
      tables: createTableSet(dialect, {
        schema: scheduler.tableSchema ?? connection.schemaName ?? undefined,
        tables: scheduler.tableNames,
      }),
      features: scheduler.features,
      schedName: scheduler.schedName,
    };
    return this.targets.withConnection(connection, async (conn) => {
      const dbNow = await queryDbNowMillis(conn, dialect);
      return fn({ conn, ctx, scheduler, dbNow });
    });
  }
}
