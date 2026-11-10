import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import {
  type ExecutingResponse,
  type GroupsResponse,
  type JobDetailResponse,
  type JobDto,
  type JobKeyQuery,
  jobKeyQuerySchema,
  type JobListQuery,
  jobListQuerySchema,
  type NodesResponse,
  type Page,
  type PausedGroupsResponse,
  type TriggerDto,
  type TriggerListQuery,
  triggerListQuerySchema,
} from '@qa/shared';
import { ZodPipe } from '../common/zod.pipe.js';
import { SchedulerViewsService } from './scheduler-views.service.js';

/**
 * 스케줄러 조회 API (TRD §8.1). 상태를 바꾸지 않으므로 감사 로그를 남기지 않는다.
 * 잡·트리거 키는 `/`를 포함할 수 있어 경로가 아니라 쿼리로 받는다.
 */
@Controller('schedulers/:id')
export class SchedulerViewsController {
  constructor(private readonly views: SchedulerViewsService) {}

  @Get('nodes')
  nodes(@Param('id', ParseIntPipe) id: number): Promise<NodesResponse> {
    return this.views.nodes(id);
  }

  @Get('paused-groups')
  pausedGroups(@Param('id', ParseIntPipe) id: number): Promise<PausedGroupsResponse> {
    return this.views.pausedGroups(id);
  }

  @Get('groups')
  groups(@Param('id', ParseIntPipe) id: number): Promise<GroupsResponse> {
    return this.views.groups(id);
  }

  @Get('jobs')
  jobs(
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodPipe(jobListQuerySchema)) query: JobListQuery,
  ): Promise<Page<JobDto>> {
    return this.views.jobs(id, query);
  }

  @Get('jobs/detail')
  jobDetail(
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodPipe(jobKeyQuerySchema)) key: JobKeyQuery,
  ): Promise<JobDetailResponse> {
    return this.views.jobDetail(id, key);
  }

  @Get('triggers')
  triggers(
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodPipe(triggerListQuerySchema)) query: TriggerListQuery,
  ): Promise<Page<TriggerDto>> {
    return this.views.triggers(id, query);
  }

  @Get('executing')
  executing(@Param('id', ParseIntPipe) id: number): Promise<ExecutingResponse> {
    return this.views.executing(id);
  }
}
