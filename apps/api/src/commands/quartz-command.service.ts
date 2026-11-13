import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  commandScope,
  type BatchCommand,
  type BatchPreviewItemDto,
  type BatchPreviewResponse,
  type BatchRequest,
  type BatchResultItemDto,
  type BatchResultResponse,
  type AuditAction,
  type AuditTargetType,
  type CommandNoticeDto,
  type CommandPreviewResponse,
  type CommandRequest,
  type CommandResultDto,
  type CommandScope,
  type CommandType,
  type QuartzCommand,
} from '@qa/shared';
import {
  executeCommand,
  expectedOf,
  isCommandRejection,
  previewCommand,
  type CommandRejection,
  type SchedulerCommandContext,
  TargetError,
} from '@qa/store';
import {
  AuditService,
  describeError,
  type AuditActor,
  type AuditEntry,
} from '../audit/audit.service.js';
import { ApiError, notFound } from '../common/api-error.js';
import { ConnectionsService, type SchedulerRow } from '../connections/connections.service.js';
import { SchedulerEvents } from '../monitor/scheduler-events.js';
import { TargetsService, type ConnectionRow } from '../targets/targets.service.js';
import { schedulerViewContext } from '../views/context.js';
import { KeyedMutex } from './keyed-mutex.js';

/** 명령 종류별 감사 작업 이름. 명령을 추가하면 타입 오류로 빠진 항목을 알려 준다 */
const AUDIT_ACTION: Record<CommandType, AuditAction> = {
  pauseTrigger: 'trigger.pause',
  resumeTrigger: 'trigger.resume',
  pauseJob: 'job.pause',
  resumeJob: 'job.resume',
  pauseTriggerGroup: 'trigger_group.pause',
  resumeTriggerGroup: 'trigger_group.resume',
  pauseJobGroup: 'job_group.pause',
  resumeJobGroup: 'job_group.resume',
  triggerJob: 'job.trigger',
  updateCronSchedule: 'trigger.reschedule',
  updateSimpleSchedule: 'trigger.reschedule',
  deleteTrigger: 'trigger.delete',
  deleteJob: 'job.delete',
};

/** 명령 대상 단위별 감사 대상 종류 */
const AUDIT_TARGET_TYPE: Record<CommandScope, AuditTargetType> = {
  trigger: 'trigger',
  job: 'job',
  triggerGroup: 'trigger_group',
  jobGroup: 'job_group',
};

/** 실행할 수 없는 접속이면 이유를 돌려준다 (FR-CTL-00a, FR-CON-04) */
export function blockedReason(connection: ConnectionRow): CommandNoticeDto | null {
  if (connection.readOnly) {
    return { code: 'READ_ONLY', message: '읽기 전용으로 지정한 접속이라 제어할 수 없습니다' };
  }
  if (connection.writeCapable !== true) {
    return {
      code: 'WRITE_NOT_CAPABLE',
      message:
        connection.writeCapable === false
          ? '접속 계정에 Quartz 테이블 쓰기 권한이 없어 제어할 수 없습니다. 권한을 받은 뒤 접속 화면에서 다시 감지하세요'
          : '쓰기 권한을 아직 확인하지 않았습니다. 접속 화면에서 감지를 실행하세요',
    };
  }
  return null;
}

/** 감사 기록의 대상. 잡·트리거 키는 이름이 바뀌어도 기록이 남도록 값 그대로 적는다 */
function auditTarget(scheduler: SchedulerRow, command: QuartzCommand): Record<string, unknown> {
  const { schedName } = scheduler;
  if ('trigger' in command) return { schedName, trigger: command.trigger };
  if ('job' in command) return { schedName, job: command.job };
  return { schedName, group: command.group };
}

function rejectionError(err: CommandRejection): ApiError {
  if (err.code === 'NOT_FOUND') return notFound(err.message);
  return new ApiError(
    // 스케줄 값이 잘못된 요청은 400, 지금 상태로는 할 수 없는 요청은 409
    err.code === 'INVALID_SCHEDULE' ? HttpStatus.BAD_REQUEST : HttpStatus.CONFLICT,
    err.code,
    err.message,
    undefined,
    {},
    {
      current: err.current,
    },
  );
}

/** 거부된 명령의 감사 기록 `after`. 상태 충돌이면 최신 상태, 그 밖에는 해당 트리거 */
function rejectionAfter(err: CommandRejection): Record<string, unknown> {
  return Array.isArray(err.current) ? { triggers: err.current } : { ...err.current };
}

/** 일괄 실행에서 이 항목이 몇 번째인지. 감사 기록 `before.batch`에 남겨 같은 일괄 실행의 기록을 묶어 본다 */
export interface BatchMeta {
  id: string;
  /** 1부터 */
  index: number;
  total: number;
}

/**
 * 일괄 실행을 멈출 오류인지. 명령 거부(상태 충돌, 없는 대상 등)와 읽기 전용, 그 항목의 대상 DB 오류는 그 항목만의 실패라 다음 항목을 실행한다.
 * 연결할 수 없거나 잠금을 기다리다 멈춘 것처럼 다음 항목도 같을 오류는 멈춘다. 항목마다 제한 시간까지 기다리지 않게 하기 위해서다
 */
function stopsBatch(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (err instanceof TargetError) return err.code !== 'TARGET_ERROR';
  return true;
}

interface Scope {
  scheduler: SchedulerRow;
  connection: ConnectionRow;
  ctx: SchedulerCommandContext;
}

/**
 * 제어 명령 (TRD §7.1, PRD FR-CTL-00a~f). 모든 명령은 `execute` 하나로 실행한다.
 *
 * 1. 사전 검사: 읽기 전용이 아니고 쓰기 권한을 확인한 접속인지
 * 2. 스케줄러 단위 뮤텍스: 같은 스케줄러의 명령은 하나씩 실행
 * 3. 감사 로그 `pending` (명령과 화면에서 본 상태)
 * 4. 대상 DB 트랜잭션 (`@qa/store` `executeCommand`: 잠금, 상태 재확인, 조건부 변경, 커밋)
 * 5. 감사 로그 결과 (변경 후 상태 또는 오류 코드)
 *
 * 잠금 범위(4단계) 밖에서만 메타 저장소를 쓴다. Quartz 노드를 기다리게 하는 시간을 줄이기 위해서다(PRD R3).
 */
@Injectable()
export class QuartzCommandService {
  private readonly logger = new Logger(QuartzCommandService.name);
  private readonly mutex = new KeyedMutex<number>();

  constructor(
    private readonly connections: ConnectionsService,
    private readonly targets: TargetsService,
    private readonly audit: AuditService,
    private readonly events: SchedulerEvents,
  ) {}

  /** 확인 대화상자용 미리보기 (FR-CTL-00b). 대상 DB를 바꾸지 않고 감사 로그도 남기지 않는다 */
  async preview(
    schedulerId: number,
    command: QuartzCommand,
    actor?: AuditActor,
  ): Promise<CommandPreviewResponse> {
    const { scheduler, connection, ctx } = this.scope(schedulerId);
    let preview;
    try {
      preview = await this.targets.withConnection(connection, (conn) =>
        previewCommand(conn, ctx, command, { actor: actor?.username }),
      );
    } catch (err) {
      throw isCommandRejection(err) ? rejectionError(err) : err;
    }
    return {
      dbNow: preview.dbNow,
      command,
      scheduler: {
        id: scheduler.id,
        displayName: scheduler.displayName,
        schedName: scheduler.schedName,
        connectionName: connection.name,
        envLabel: connection.envLabel,
      },
      targets: preview.subject.triggers,
      expected: expectedOf(preview.subject),
      changes: preview.plan.changes,
      groupChanges: preview.plan.groupChanges,
      inserts: preview.plan.inserts,
      scheduleChanges: preview.plan.scheduleChanges.map(({ group, name, from, to, upcoming }) => ({
        group,
        name,
        from,
        to,
        upcoming,
      })),
      deletions: preview.plan.deletions ?? { triggers: [], jobs: [] },
      warnings: preview.plan.warnings,
      blocked: blockedReason(connection) ?? preview.plan.rejection,
    };
  }

  /** 명령 실행. 성공과 실패를 모두 감사 로그에 남긴다 (FR-CTL-00f) */
  async execute(
    schedulerId: number,
    request: CommandRequest,
    actor: AuditActor,
    batch?: BatchMeta,
  ): Promise<CommandResultDto> {
    const { scheduler, connection, ctx } = this.scope(schedulerId);
    const { command, expected } = request;
    const requested = { command, expected, ...(batch ? { batch } : {}) };
    const entry: AuditEntry = {
      actor,
      action: AUDIT_ACTION[command.type],
      targetType: AUDIT_TARGET_TYPE[commandScope(command)],
      target: auditTarget(scheduler, command),
      connectionId: connection.id,
      schedulerId: scheduler.id,
      before: requested,
    };

    const blocked = blockedReason(connection);
    if (blocked) {
      const err = new ApiError(HttpStatus.CONFLICT, 'READ_ONLY', blocked.message);
      this.audit.failure(entry, err);
      throw err;
    }

    return this.mutex.run(scheduler.id, async () => {
      const pending = this.audit.begin(entry);
      try {
        const out = await this.targets.withConnection(connection, (conn) =>
          executeCommand(conn, ctx, command, expected, { actor: actor.username }),
        );
        const after = expectedOf(out.after);
        const changed =
          out.changes.length +
            out.groupChanges.length +
            out.inserts.length +
            out.scheduleChanges.length +
            out.deletions.triggers.length +
            out.deletions.jobs.length >
          0;
        const deleted = out.deletions.triggers.length + out.deletions.jobs.length > 0;
        pending.succeed({
          // 삭제는 잠금 안에서 읽은 삭제 전 정의를 남긴다(자동 복원은 범위 밖, FR-CTL-09)
          ...(out.snapshot ? { before: { ...requested, snapshot: out.snapshot } } : {}),
          after: {
            ...after,
            changes: out.changes,
            groupChanges: out.groupChanges,
            ...(out.inserts.length > 0 ? { inserts: out.inserts } : {}),
            ...(out.scheduleChanges.length > 0 ? { scheduleChanges: out.scheduleChanges } : {}),
            ...(deleted ? { deletions: out.deletions } : {}),
          },
        });
        this.logger.log(
          `제어 명령 성공 (스케줄러 ${scheduler.id}, ${command.type}): ` +
            `트리거 ${out.changes.length}건, 그룹 ${out.groupChanges.length}건, 추가 ${out.inserts.length}건`,
        );
        if (changed) {
          // 대시보드 카드(스냅샷)도 바로 다시 읽게 한다 (NFR-UX-03)
          this.events.emit({ type: 'upsert', schedulerId: scheduler.id, immediate: true });
        }
        return {
          dbNow: out.dbNow,
          command,
          changed,
          changes: out.changes,
          groupChanges: out.groupChanges,
          inserts: out.inserts,
          scheduleChanges: out.scheduleChanges,
          deletions: out.deletions,
          warnings: out.warnings,
          before: expectedOf(out.before),
          after,
          auditId: pending.id,
        };
      } catch (err) {
        const failure = isCommandRejection(err) ? rejectionError(err) : err;
        pending.fail(
          failure,
          isCommandRejection(err) && err.current ? { after: rejectionAfter(err) } : undefined,
        );
        this.logger.warn(
          `제어 명령 실패 (스케줄러 ${scheduler.id}, ${command.type}): ${describeError(failure).code}`,
        );
        throw failure;
      }
    });
  }

  /**
   * 일괄 미리보기 (FR-CTL-10). 커넥션 하나로 항목마다 단건 미리보기를 읽는다.
   * 없어진 대상처럼 그 항목만의 거부는 항목의 `error`로 돌려주고, 대상 DB에 연결할 수 없으면 요청 전체가 실패한다
   */
  async batchPreview(
    schedulerId: number,
    commands: BatchCommand[],
    actor?: AuditActor,
  ): Promise<BatchPreviewResponse> {
    const { scheduler, connection, ctx } = this.scope(schedulerId);
    const { dbNow, items } = await this.targets.withConnection(connection, async (conn) => {
      let dbNow = 0;
      const items: BatchPreviewItemDto[] = [];
      // 항목 순서대로 읽는다. 한 커넥션이라 동시에 보낼 수 없다
      for (const command of commands) {
        try {
          const p = await previewCommand(conn, ctx, command, { actor: actor?.username });
          dbNow = p.dbNow;
          items.push({
            command,
            preview: {
              targets: p.subject.triggers,
              expected: expectedOf(p.subject),
              changes: p.plan.changes,
              warnings: p.plan.warnings,
              blocked: p.plan.rejection,
            },
            error: null,
          });
        } catch (err) {
          if (!isCommandRejection(err)) throw err;
          items.push({ command, preview: null, error: { code: err.code, message: err.message } });
        }
      }
      return { dbNow, items };
    });
    return {
      dbNow,
      scheduler: {
        id: scheduler.id,
        displayName: scheduler.displayName,
        schedName: scheduler.schedName,
        connectionName: connection.name,
        envLabel: connection.envLabel,
      },
      blocked: blockedReason(connection),
      items,
    };
  }

  /**
   * 일괄 실행 (FR-CTL-10). 항목마다 `execute`와 같은 절차(뮤텍스, 트랜잭션, 감사 기록)로 하나씩 실행한다.
   * 항목마다 잠금을 잡았다 풀어 Quartz 노드를 오래 기다리게 하지 않는다. 한 항목이 실패해도 다음 항목을 실행하고,
   * 계속할 수 없는 오류(`stopsBatch`)가 나면 남은 항목은 실행하지 않고 `skipped`로 돌려준다
   */
  async batchExecute(
    schedulerId: number,
    request: BatchRequest,
    actor: AuditActor,
  ): Promise<BatchResultResponse> {
    // 없는 스케줄러면 감사 기록 없이 404
    this.scope(schedulerId);
    const batchId = randomUUID();
    const total = request.items.length;
    const items: BatchResultItemDto[] = [];
    let stopped = false;
    for (const [i, { command, expected }] of request.items.entries()) {
      if (stopped) {
        items.push({
          command,
          status: 'skipped',
          error: {
            code: 'BATCH_STOPPED',
            message: '앞 항목에서 계속할 수 없는 오류가 나 실행하지 않았습니다',
          },
        });
        continue;
      }
      try {
        const out = await this.execute(schedulerId, { command, expected }, actor, {
          id: batchId,
          index: i + 1,
          total,
        });
        items.push({
          command,
          status: 'success',
          changed: out.changed,
          changes: out.changes,
          warnings: out.warnings,
          auditId: out.auditId,
        });
      } catch (err) {
        items.push({ command, status: 'failure', error: describeError(err) });
        stopped = stopsBatch(err);
      }
    }
    const failed = items.filter((it) => it.status !== 'success').length;
    this.logger.log(
      `일괄 제어 (스케줄러 ${schedulerId}, ${batchId}): ${total}건 중 실패·건너뜀 ${failed}건`,
    );
    return { batchId, items };
  }

  private scope(schedulerId: number): Scope {
    const scheduler = this.connections.requireScheduler(schedulerId);
    const connection = this.connections.require(scheduler.connectionId);
    return {
      scheduler,
      connection,
      ctx: {
        ...schedulerViewContext(scheduler, connection),
        checkinMultiplier: scheduler.checkinMultiplier,
      },
    };
  }
}
