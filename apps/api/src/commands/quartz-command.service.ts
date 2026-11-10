import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  commandScope,
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
    HttpStatus.CONFLICT,
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
  async preview(schedulerId: number, command: QuartzCommand): Promise<CommandPreviewResponse> {
    const { scheduler, connection, ctx } = this.scope(schedulerId);
    let preview;
    try {
      preview = await this.targets.withConnection(connection, (conn) =>
        previewCommand(conn, ctx, command),
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
      warnings: preview.plan.warnings,
      blocked: blockedReason(connection) ?? preview.plan.rejection,
    };
  }

  /** 명령 실행. 성공과 실패를 모두 감사 로그에 남긴다 (FR-CTL-00f) */
  async execute(
    schedulerId: number,
    request: CommandRequest,
    actor: AuditActor,
  ): Promise<CommandResultDto> {
    const { scheduler, connection, ctx } = this.scope(schedulerId);
    const { command, expected } = request;
    const entry: AuditEntry = {
      actor,
      action: AUDIT_ACTION[command.type],
      targetType: AUDIT_TARGET_TYPE[commandScope(command)],
      target: auditTarget(scheduler, command),
      connectionId: connection.id,
      schedulerId: scheduler.id,
      before: { command, expected },
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
          executeCommand(conn, ctx, command, expected),
        );
        const after = expectedOf(out.after);
        const changed = out.changes.length + out.groupChanges.length > 0;
        pending.succeed({
          after: { ...after, changes: out.changes, groupChanges: out.groupChanges },
        });
        this.logger.log(
          `제어 명령 성공 (스케줄러 ${scheduler.id}, ${command.type}): ` +
            `트리거 ${out.changes.length}건, 그룹 ${out.groupChanges.length}건`,
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

  private scope(schedulerId: number): Scope {
    const scheduler = this.connections.requireScheduler(schedulerId);
    const connection = this.connections.require(scheduler.connectionId);
    return { scheduler, connection, ctx: schedulerViewContext(scheduler, connection) };
  }
}
