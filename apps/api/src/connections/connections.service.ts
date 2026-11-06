import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  ConnectionDto,
  ConnectionTestResult,
  CreateConnectionInput,
  DeleteImpactDto,
  DetectedTableSet,
  DetectionDto,
  QuartzDetection,
  RegisterSchedulersInput,
  SchedulerDto,
  DashboardQuery,
  DashboardResponse,
  SchedulerConnectionSummary,
  SchedulerDetailDto,
  SchedulerSettings,
  SchedulerSummaryDto,
  SnapshotDto,
  TestConnectionInput,
  UpdateConnectionInput,
} from '@qa/shared';
import { TargetError } from '@qa/store';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { ApiError, notFound } from '../common/api-error.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { SecretBox, secretAad } from '../crypto/secret-box.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import {
  alertRules,
  alerts,
  connections,
  schedulerSnapshots,
  schedulers,
} from '../meta-db/schema.js';
import { SchedulerEvents } from '../monitor/scheduler-events.js';
import { toSnapshotDto } from '../monitor/monitor.service.js';
import { TargetsService, type ConnectionRow } from '../targets/targets.service.js';

export type SchedulerRow = typeof schedulers.$inferSelect;

export function toConnectionDto(row: ConnectionRow, schedulerCount: number): ConnectionDto {
  return {
    id: row.id,
    name: row.name,
    dbType: row.dbType,
    host: row.host,
    port: row.port,
    database: row.database,
    oracleServiceName: row.oracleServiceName,
    oracleSid: row.oracleSid,
    schemaName: row.schemaName,
    username: row.username,
    envLabel: row.envLabel,
    tags: row.tags,
    readOnly: row.readOnly,
    writeCapable: row.writeCapable,
    schedulerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSchedulerDto(row: SchedulerRow): SchedulerDto {
  return {
    id: row.id,
    connectionId: row.connectionId,
    tablePrefix: row.tablePrefix,
    tableSchema: row.tableSchema,
    schedName: row.schedName,
    displayName: row.displayName,
    tableNames: row.tableNames,
    features: row.features,
    boolFormat: row.boolFormat,
    misfireThresholdMs: row.misfireThresholdMs,
    overdueGraceMs: row.overdueGraceMs,
    checkinMultiplier: row.checkinMultiplier,
    expectedNodeCount: row.expectedNodeCount,
    pollIntervalSec: row.pollIntervalSec,
    detectedAt: row.detectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function connectionSummary(row: ConnectionRow): SchedulerConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    dbType: row.dbType,
    envLabel: row.envLabel,
    tags: row.tags,
    readOnly: row.readOnly,
    writeCapable: row.writeCapable,
  };
}

/** 감사 기록용 접속 값. 비밀번호와 암호문은 넣지 않는다 */
export function connectionAuditView(row: ConnectionRow): Record<string, unknown> {
  return {
    name: row.name,
    dbType: row.dbType,
    host: row.host,
    port: row.port,
    database: row.database,
    oracleServiceName: row.oracleServiceName,
    oracleSid: row.oracleSid,
    schemaName: row.schemaName,
    username: row.username,
    envLabel: row.envLabel,
    tags: row.tags,
    readOnly: row.readOnly,
  };
}

export function schedulerSettingsView(row: SchedulerRow): SchedulerSettings {
  return {
    displayName: row.displayName,
    misfireThresholdMs: row.misfireThresholdMs,
    overdueGraceMs: row.overdueGraceMs,
    checkinMultiplier: row.checkinMultiplier,
    expectedNodeCount: row.expectedNodeCount,
    pollIntervalSec: row.pollIntervalSec,
  };
}

/** 대상 DB에 연결하는 데 쓰는 값. 이 값이 바뀌면 풀을 버린다 */
const TARGET_KEYS = [
  'dbType',
  'host',
  'port',
  'database',
  'oracleServiceName',
  'oracleSid',
  'schemaName',
  'username',
] as const;

const nameTaken = (name: string) =>
  new ApiError(HttpStatus.CONFLICT, 'CONNECTION_NAME_TAKEN', `이미 있는 접속 이름입니다: ${name}`);

/** 연결 테스트 결과에 넣는 요약. 세트가 없으면 쓰기 가능 여부를 판단하지 않는다 */
function writeCapableOf(detection: QuartzDetection): boolean | null {
  return detection.tableSets.length === 0 ? null : detection.tableSets.every((s) => s.writeCapable);
}

/** 접속·스케줄러 관리 (PRD FR-CON-01~07, TRD §5.7) */
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly metaDb: MetaDbService,
    private readonly secrets: SecretBox,
    private readonly targets: TargetsService,
    private readonly events: SchedulerEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ── 접속 ─────────────────────────────────────────────

  list(): ConnectionDto[] {
    const counts = this.schedulerCounts();
    return this.metaDb.db
      .select()
      .from(connections)
      .orderBy(asc(connections.name))
      .all()
      .map((row) => toConnectionDto(row, counts.get(row.id) ?? 0));
  }

  findById(id: number): ConnectionRow | undefined {
    return this.metaDb.db.select().from(connections).where(eq(connections.id, id)).get();
  }

  require(id: number): ConnectionRow {
    const row = this.findById(id);
    if (!row) throw notFound('접속을 찾을 수 없습니다');
    return row;
  }

  get(id: number): ConnectionDto {
    const row = this.require(id);
    return toConnectionDto(row, this.schedulerCounts(id).get(id) ?? 0);
  }

  /**
   * 접속 등록 (FR-CON-01). 비밀번호 암호문의 AAD에 행 ID가 들어가므로, 같은 트랜잭션에서
   * 빈 값으로 INSERT한 뒤 받은 ID로 암호화해 UPDATE한다 (TRD §4.1).
   */
  create(input: CreateConnectionInput, userId: number | null): ConnectionRow {
    const now = this.clock();
    return this.metaDb.db.transaction((tx) => {
      if (tx.select().from(connections).where(eq(connections.name, input.name)).get()) {
        throw nameTaken(input.name);
      }
      const inserted = tx
        .insert(connections)
        .values({
          ...this.columns(input),
          passwordEnc: '',
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: connections.id })
        .get();
      return tx
        .update(connections)
        .set({ passwordEnc: this.encrypt(input.password, inserted.id) })
        .where(eq(connections.id, inserted.id))
        .returning()
        .get();
    });
  }

  /** 접속 수정 (FR-CON-05). 비밀번호를 비워 두면 기존 값을 쓴다 */
  async update(
    id: number,
    input: UpdateConnectionInput,
  ): Promise<{ before: ConnectionRow; after: ConnectionRow; passwordChanged: boolean }> {
    const before = this.require(id);
    const duplicate = this.metaDb.db
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.name, input.name), ne(connections.id, id)))
      .get();
    if (duplicate) throw nameTaken(input.name);

    const columns = this.columns(input);
    const targetChanged =
      input.password !== undefined ||
      TARGET_KEYS.some((k) => (before[k] ?? null) !== (columns[k] ?? null));
    const after = this.metaDb.db
      .update(connections)
      .set({
        ...columns,
        ...(input.password !== undefined ? { passwordEnc: this.encrypt(input.password, id) } : {}),
        // 다른 대상을 가리키게 되면 이전 감지 결과는 의미가 없다
        ...(targetChanged ? { writeCapable: null } : {}),
        updatedAt: this.clock(),
      })
      .where(eq(connections.id, id))
      .returning()
      .get();
    if (targetChanged) {
      await this.targets.forget(id);
      // 새 접속 정보로 바로 다시 감시한다
      for (const sid of this.schedulerIdsOf(id)) {
        this.events.emit({ type: 'upsert', schedulerId: sid, immediate: true });
      }
    }
    return { before, after, passwordChanged: input.password !== undefined };
  }

  /** 삭제 영향 미리보기 (FR-CON-05) */
  deleteImpact(id: number): DeleteImpactDto {
    this.require(id);
    const rows = this.metaDb.db
      .select({
        id: schedulers.id,
        displayName: schedulers.displayName,
        schedName: schedulers.schedName,
      })
      .from(schedulers)
      .where(eq(schedulers.connectionId, id))
      .orderBy(asc(schedulers.displayName))
      .all();
    return { schedulers: rows, ...this.alertCounts(rows.map((r) => r.id)) };
  }

  /** 접속 삭제. 하위 스케줄러, 알림 규칙, 알림, 스냅샷은 외래키 cascade로 함께 지워진다 */
  async delete(id: number): Promise<{ row: ConnectionRow; impact: DeleteImpactDto }> {
    const row = this.require(id);
    const impact = this.deleteImpact(id);
    this.metaDb.db.delete(connections).where(eq(connections.id, id)).run();
    for (const s of impact.schedulers) this.events.emit({ type: 'remove', schedulerId: s.id });
    await this.targets.forget(id);
    return { row, impact };
  }

  // ── 연결 테스트와 감지 ─────────────────────────────────

  /**
   * 연결 테스트 (FR-CON-02). 저장 전 값으로 접속해 감지까지 해 본다.
   * 실패도 결과로 돌려주며, 원인은 `TargetError` 코드로 나눈다(네트워크, 인증, 시간 초과, 그 밖).
   */
  async test(input: TestConnectionInput): Promise<ConnectionTestResult> {
    let password = input.password;
    if (password === undefined) {
      const stored = this.require(input.connectionId!);
      password = this.targets.connectInfo(stored).password;
    }
    const started = this.clock();
    try {
      const detection = await this.targets.detectOnce(
        {
          kind: input.dbType,
          host: input.host,
          port: input.port,
          username: input.username,
          password,
          database: input.database,
          oracleServiceName: input.oracleServiceName,
          oracleSid: input.oracleSid,
        },
        input.schemaName,
      );
      return {
        ok: true,
        durationMs: this.clock() - started,
        schema: detection.schema,
        tableSetCount: detection.tableSets.length,
        schedulerCount: detection.tableSets.reduce((n, s) => n + s.schedulers.length, 0),
        writeCapable: writeCapableOf(detection),
      };
    } catch (err) {
      if (!(err instanceof TargetError)) throw err;
      return {
        ok: false,
        durationMs: this.clock() - started,
        code: err.code,
        message: err.message,
      };
    }
  }

  /**
   * 감지와 재감지 (FR-CON-03, 05). 결과를 후보 목록으로 돌려주고,
   * 이미 등록된 스케줄러는 테이블 이름·기능·불리언 형식을 새 결과로 갱신한다.
   */
  async detect(id: number): Promise<DetectionDto> {
    const row = this.require(id);
    const detection = await this.targets.detect(row);
    const now = this.clock();
    const registered = this.metaDb.db
      .select()
      .from(schedulers)
      .where(eq(schedulers.connectionId, id))
      .all();

    const refreshed: number[] = [];
    this.metaDb.db.transaction((tx) => {
      for (const scheduler of registered) {
        const set = detection.tableSets.find((s) => s.prefix === scheduler.tablePrefix);
        if (!set?.schedulers.some((c) => c.schedName === scheduler.schedName)) continue;
        tx.update(schedulers)
          .set({
            tableSchema: detection.schema,
            tableNames: set.tableNames,
            features: { ...set.features },
            boolFormat: set.boolFormat,
            detectedAt: now,
            updatedAt: now,
          })
          .where(eq(schedulers.id, scheduler.id))
          .run();
        refreshed.push(scheduler.id);
      }
      tx.update(connections)
        .set({ writeCapable: writeCapableOf(detection), updatedAt: now })
        .where(eq(connections.id, id))
        .run();
    });

    const registeredId = (prefix: string, schedName: string) =>
      registered.find((s) => s.tablePrefix === prefix && s.schedName === schedName)?.id ?? null;
    return {
      connectionId: id,
      schema: detection.schema,
      dbNow: detection.dbNow,
      tableSets: detection.tableSets.map((set) => ({
        ...set,
        schedulers: set.schedulers.map((c) => ({
          ...c,
          registeredSchedulerId: registeredId(set.prefix, c.schedName),
        })),
      })),
      unusable: detection.unusable,
      refreshedSchedulerIds: refreshed,
      missingSchedulerIds: registered.map((s) => s.id).filter((sid) => !refreshed.includes(sid)),
    };
  }

  // ── 스케줄러 ───────────────────────────────────────────

  listSchedulers(connectionId: number): SchedulerDto[] {
    this.require(connectionId);
    return this.metaDb.db
      .select()
      .from(schedulers)
      .where(eq(schedulers.connectionId, connectionId))
      .orderBy(asc(schedulers.displayName))
      .all()
      .map(toSchedulerDto);
  }

  /**
   * 감지 결과에서 고른 후보를 등록한다 (FR-CON-03). 화면이 보낸 테이블 이름을 믿지 않고 다시 감지해서
   * 카탈로그로 확인한 이름만 저장한다 (NFR-SEC-02, TRD §4.4). 기대 노드 수는 활성 노드 수로 시작한다.
   */
  async registerSchedulers(
    connectionId: number,
    input: RegisterSchedulersInput,
  ): Promise<SchedulerRow[]> {
    const row = this.require(connectionId);
    const detection = await this.targets.detect(row);
    const now = this.clock();

    const picked = input.selections.map((sel) => {
      const set = detection.tableSets.find((s) => s.prefix === sel.prefix);
      const candidate = set?.schedulers.find((c) => c.schedName === sel.schedName);
      if (!set || !candidate) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'SCHEDULER_NOT_DETECTED',
          `감지 결과에 없는 스케줄러입니다: ${sel.prefix}${sel.prefix ? ' ' : ''}${sel.schedName}. 다시 감지한 뒤 고르세요`,
        );
      }
      return { sel, set, candidate };
    });

    const created = this.metaDb.db.transaction((tx) => {
      const created: SchedulerRow[] = [];
      for (const { sel, set, candidate } of picked) {
        const exists = tx
          .select({ id: schedulers.id })
          .from(schedulers)
          .where(
            and(
              eq(schedulers.connectionId, connectionId),
              eq(schedulers.tablePrefix, set.prefix),
              eq(schedulers.schedName, candidate.schedName),
            ),
          )
          .get();
        if (exists) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            'SCHEDULER_ALREADY_REGISTERED',
            `이미 등록된 스케줄러입니다: ${candidate.schedName}`,
          );
        }
        created.push(
          tx
            .insert(schedulers)
            .values({
              connectionId,
              tablePrefix: set.prefix,
              tableSchema: detection.schema,
              tableNames: set.tableNames,
              schedName: candidate.schedName,
              displayName:
                sel.displayName ?? defaultDisplayName(set, candidate.schedName, detection),
              features: { ...set.features },
              boolFormat: set.boolFormat,
              expectedNodeCount: candidate.expectedNodeCount,
              detectedAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get(),
        );
      }
      tx.update(connections)
        .set({ writeCapable: writeCapableOf(detection), updatedAt: now })
        .where(eq(connections.id, connectionId))
        .run();
      return created;
    });
    // 대시보드에 바로 나타나도록 첫 감시를 기다리지 않고 돌린다
    for (const row of created)
      this.events.emit({ type: 'upsert', schedulerId: row.id, immediate: true });
    return created;
  }

  findScheduler(id: number): SchedulerRow | undefined {
    return this.metaDb.db.select().from(schedulers).where(eq(schedulers.id, id)).get();
  }

  requireScheduler(id: number): SchedulerRow {
    const row = this.findScheduler(id);
    if (!row) throw notFound('스케줄러를 찾을 수 없습니다');
    return row;
  }

  /** 스케줄러 설정 (FR-CON-07) */
  updateSettings(id: number, settings: SchedulerSettings): SchedulerRow {
    this.requireScheduler(id);
    const row = this.metaDb.db
      .update(schedulers)
      .set({ ...settings, updatedAt: this.clock() })
      .where(eq(schedulers.id, id))
      .returning()
      .get();
    // 감시 주기나 판정 기준이 바뀌었을 수 있다
    this.events.emit({ type: 'upsert', schedulerId: id });
    return row;
  }

  /**
   * 대시보드 (FR-VIEW-01, TRD §8.4). 대상 DB를 조회하지 않고 메타 저장소와 스냅샷만 읽는다.
   * 그래서 연결할 수 없는 대상이 섞여 있어도 응답 시간이 일정하다(NFR-PERF-01, FR-VIEW-07).
   */
  dashboard(query: DashboardQuery): DashboardResponse {
    const rows = this.metaDb.db
      .select({ scheduler: schedulers, connection: connections, snapshot: schedulerSnapshots })
      .from(schedulers)
      .innerJoin(connections, eq(connections.id, schedulers.connectionId))
      .leftJoin(schedulerSnapshots, eq(schedulerSnapshots.schedulerId, schedulers.id))
      .orderBy(asc(connections.name), asc(schedulers.displayName))
      .all();
    const alertCounts = this.openAlertCounts();
    const q = query.q?.toLowerCase();
    const items: SchedulerSummaryDto[] = rows
      .filter(({ scheduler, connection }) => {
        if (query.env !== undefined && connection.envLabel !== query.env) return false;
        if (query.tag !== undefined && !connection.tags.includes(query.tag)) return false;
        if (q !== undefined) {
          const names = [scheduler.displayName, scheduler.schedName, connection.name];
          if (!names.some((n) => n.toLowerCase().includes(q))) return false;
        }
        return true;
      })
      .map(({ scheduler, connection, snapshot }) => ({
        id: scheduler.id,
        displayName: scheduler.displayName,
        schedName: scheduler.schedName,
        tablePrefix: scheduler.tablePrefix,
        expectedNodeCount: scheduler.expectedNodeCount,
        pollIntervalSec: scheduler.pollIntervalSec,
        connection: connectionSummary(connection),
        snapshot: snapshot ? toSnapshotDto(snapshot) : null,
        openAlertCount: alertCounts.get(scheduler.id) ?? 0,
      }));
    return {
      generatedAt: this.clock(),
      items,
      envs: [...new Set(rows.map((r) => r.connection.envLabel))].sort(),
      tags: [...new Set(rows.flatMap((r) => r.connection.tags))].sort(),
    };
  }

  /** 스케줄러 상세 (TRD §8.1 `GET /schedulers/:id`) */
  schedulerDetail(id: number): SchedulerDetailDto {
    const scheduler = this.requireScheduler(id);
    return {
      ...toSchedulerDto(scheduler),
      connection: connectionSummary(this.require(scheduler.connectionId)),
      snapshot: this.snapshot(id),
      openAlertCount: this.openAlertCounts(id).get(id) ?? 0,
    };
  }

  /** 감시 루프가 남긴 마지막 스냅샷 (TRD §8.4). 아직 감시하지 않았으면 null */
  snapshot(id: number): SnapshotDto | null {
    this.requireScheduler(id);
    const row = this.metaDb.db
      .select()
      .from(schedulerSnapshots)
      .where(eq(schedulerSnapshots.schedulerId, id))
      .get();
    return row ? toSnapshotDto(row) : null;
  }

  schedulerDeleteImpact(id: number): DeleteImpactDto {
    const row = this.requireScheduler(id);
    return {
      schedulers: [{ id: row.id, displayName: row.displayName, schedName: row.schedName }],
      ...this.alertCounts([row.id]),
    };
  }

  /** 스케줄러 등록 해제. 대상 DB에는 아무것도 하지 않는다 */
  deleteScheduler(id: number): { row: SchedulerRow; impact: DeleteImpactDto } {
    const impact = this.schedulerDeleteImpact(id);
    const row = this.requireScheduler(id);
    this.metaDb.db.delete(schedulers).where(eq(schedulers.id, id)).run();
    this.events.emit({ type: 'remove', schedulerId: id });
    return { row, impact };
  }

  // ── 내부 ──────────────────────────────────────────────

  private columns(input: CreateConnectionInput | UpdateConnectionInput) {
    return {
      name: input.name,
      dbType: input.dbType,
      host: input.host,
      port: input.port,
      database: input.database ?? null,
      oracleServiceName: input.oracleServiceName ?? null,
      oracleSid: input.oracleSid ?? null,
      schemaName: input.schemaName ?? null,
      username: input.username,
      envLabel: input.envLabel,
      tags: input.tags,
      readOnly: input.readOnly,
    };
  }

  private openAlertCounts(schedulerId?: number): Map<number, number> {
    const rows = this.metaDb.db
      .select({ schedulerId: alerts.schedulerId, n: count() })
      .from(alerts)
      .where(
        and(
          ne(alerts.status, 'resolved'),
          schedulerId === undefined ? undefined : eq(alerts.schedulerId, schedulerId),
        ),
      )
      .groupBy(alerts.schedulerId)
      .all();
    return new Map(rows.map((r) => [r.schedulerId, r.n]));
  }

  private schedulerIdsOf(connectionId: number): number[] {
    return this.metaDb.db
      .select({ id: schedulers.id })
      .from(schedulers)
      .where(eq(schedulers.connectionId, connectionId))
      .all()
      .map((r) => r.id);
  }

  private encrypt(password: string, id: number): string {
    return this.secrets.encrypt(password, secretAad('connections', id));
  }

  private schedulerCounts(connectionId?: number): Map<number, number> {
    const rows = this.metaDb.db
      .select({ connectionId: schedulers.connectionId, n: count() })
      .from(schedulers)
      .where(connectionId === undefined ? undefined : eq(schedulers.connectionId, connectionId))
      .groupBy(schedulers.connectionId)
      .all();
    return new Map(rows.map((r) => [r.connectionId, r.n]));
  }

  private alertCounts(schedulerIds: number[]): Omit<DeleteImpactDto, 'schedulers'> {
    if (schedulerIds.length === 0) return { alertRuleCount: 0, openAlertCount: 0 };
    const rules = this.metaDb.db
      .select({ n: count() })
      .from(alertRules)
      .where(inArray(alertRules.schedulerId, schedulerIds))
      .get();
    const open = this.metaDb.db
      .select({ n: count() })
      .from(alerts)
      .where(and(inArray(alerts.schedulerId, schedulerIds), ne(alerts.status, 'resolved')))
      .get();
    return { alertRuleCount: rules?.n ?? 0, openAlertCount: open?.n ?? 0 };
  }
}

/** 표시 이름 기본값. 같은 SCHED_NAME이 여러 prefix에 있으면 prefix를 붙여 구분한다 */
function defaultDisplayName(
  set: DetectedTableSet,
  schedName: string,
  detection: QuartzDetection,
): string {
  const duplicated =
    detection.tableSets.filter((s) => s.schedulers.some((c) => c.schedName === schedName)).length >
    1;
  return duplicated ? `${schedName} (${set.prefix || 'prefix 없음'})` : schedName;
}
