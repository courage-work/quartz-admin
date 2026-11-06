import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  type ConnectionDto,
  type ConnectionTestResult,
  type CreateConnectionInput,
  createConnectionRequestSchema,
  type DeleteImpactDto,
  type DetectionDto,
  type RegisterSchedulersInput,
  registerSchedulersRequestSchema,
  type SchedulerDto,
  type TestConnectionInput,
  testConnectionRequestSchema,
  type UpdateConnectionInput,
  updateConnectionRequestSchema,
} from '@qa/shared';
import { actorOf } from '../audit/actor.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthedRequest } from '../auth/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import {
  ConnectionsService,
  connectionAuditView,
  toConnectionDto,
  toSchedulerDto,
} from './connections.service.js';

/**
 * 접속 관리 API (PRD FR-CON-01~06, TRD §5.7). 로그인한 사용자는 모두 쓸 수 있다(PRD §6.7 권한 모델).
 * 비밀번호는 요청으로만 받고 응답·감사 기록에는 넣지 않는다.
 */
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(): ConnectionDto[] {
    return this.connections.list();
  }

  /** 저장 전 연결 테스트. 실패해도 200으로 원인을 돌려준다 (FR-CON-02) */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(
    @Body(new ZodPipe(testConnectionRequestSchema)) body: TestConnectionInput,
  ): Promise<ConnectionTestResult> {
    return this.connections.test(body);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): ConnectionDto {
    return this.connections.get(id);
  }

  @Post()
  create(
    @Req() req: AuthedRequest,
    @Body(new ZodPipe(createConnectionRequestSchema)) body: CreateConnectionInput,
  ): Promise<ConnectionDto> {
    return this.audit
      .run(
        {
          actor: actorOf(req),
          action: 'connection.create',
          targetType: 'connection',
          target: { name: body.name },
        },
        () => this.connections.create(body, req.auth?.user.id ?? null),
        (row) => ({ target: { id: row.id, name: row.name }, after: connectionAuditView(row) }),
      )
      .then((row) => toConnectionDto(row, 0));
  }

  /** 접속 수정. 비밀번호를 비워 두면 기존 값을 유지한다 (FR-CON-05) */
  @Put(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(updateConnectionRequestSchema)) body: UpdateConnectionInput,
  ): Promise<ConnectionDto> {
    const current = this.connections.findById(id);
    await this.audit.run(
      {
        actor: actorOf(req),
        action: 'connection.update',
        targetType: 'connection',
        target: { id, name: current?.name ?? null },
        connectionId: id,
        ...(current ? { before: connectionAuditView(current) } : {}),
      },
      () => this.connections.update(id, body),
      (result) => ({
        after: { ...connectionAuditView(result.after), passwordChanged: result.passwordChanged },
      }),
    );
    return this.connections.get(id);
  }

  @Get(':id/delete-impact')
  deleteImpact(@Param('id', ParseIntPipe) id: number): DeleteImpactDto {
    return this.connections.deleteImpact(id);
  }

  /** 접속 삭제. 하위 스케줄러와 알림 규칙도 함께 지워진다 (FR-CON-05) */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<void> {
    const current = this.connections.findById(id);
    await this.audit.run(
      {
        actor: actorOf(req),
        action: 'connection.delete',
        targetType: 'connection',
        target: { id, name: current?.name ?? null },
        connectionId: id,
        ...(current ? { before: connectionAuditView(current) } : {}),
      },
      () => this.connections.delete(id),
      ({ impact }) => ({ after: { deleted: true, ...impact } }),
    );
  }

  /** 감지와 재감지 (FR-CON-03, 05). 등록된 스케줄러의 테이블 정보를 새 결과로 갱신한다 */
  @Post(':id/detect')
  @HttpCode(HttpStatus.OK)
  detect(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<DetectionDto> {
    const current = this.connections.findById(id);
    return this.audit.run(
      {
        actor: actorOf(req),
        action: 'connection.detect',
        targetType: 'connection',
        target: { id, name: current?.name ?? null },
        connectionId: id,
        ...(current ? { before: { writeCapable: current.writeCapable } } : {}),
      },
      () => this.connections.detect(id),
      (d) => ({
        after: {
          schema: d.schema,
          tableSets: d.tableSets.map((s) => ({
            prefix: s.prefix,
            writeCapable: s.writeCapable,
            schedulers: s.schedulers.map((c) => c.schedName),
          })),
          unusable: d.unusable.map((u) => ({ prefix: u.prefix, reason: u.reason })),
          refreshedSchedulerIds: d.refreshedSchedulerIds,
          missingSchedulerIds: d.missingSchedulerIds,
        },
      }),
    );
  }

  @Get(':id/schedulers')
  schedulers(@Param('id', ParseIntPipe) id: number): SchedulerDto[] {
    return this.connections.listSchedulers(id);
  }

  /** 감지한 후보를 스케줄러로 등록한다 (FR-CON-03) */
  @Post(':id/schedulers')
  async register(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(registerSchedulersRequestSchema)) body: RegisterSchedulersInput,
  ): Promise<SchedulerDto[]> {
    const current = this.connections.findById(id);
    const rows = await this.audit.run(
      {
        actor: actorOf(req),
        action: 'scheduler.register',
        targetType: 'scheduler',
        target: {
          connectionId: id,
          connectionName: current?.name ?? null,
          selections: body.selections,
        },
        connectionId: id,
      },
      () => this.connections.registerSchedulers(id, body),
      (created) => ({
        target: {
          connectionId: id,
          connectionName: current?.name ?? null,
          schedulers: created.map((s) => ({
            id: s.id,
            prefix: s.tablePrefix,
            schedName: s.schedName,
            displayName: s.displayName,
          })),
        },
        after: created.map((s) => ({
          id: s.id,
          boolFormat: s.boolFormat,
          expectedNodeCount: s.expectedNodeCount,
        })),
      }),
    );
    return rows.map(toSchedulerDto);
  }
}
