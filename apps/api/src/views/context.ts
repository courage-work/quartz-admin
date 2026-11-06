import { TargetError, createTableSet, dialectFor, type SchedulerViewContext } from '@qa/store';
import type { SchedulerRow } from '../connections/connections.service.js';
import type { ConnectionRow } from '../targets/targets.service.js';

/** 메타 저장소의 스케줄러·접속 행으로 대상 DB 조회 문맥을 만든다(조회 API와 감시 루프가 함께 쓴다) */
export function schedulerViewContext(
  scheduler: SchedulerRow,
  connection: ConnectionRow,
): SchedulerViewContext {
  const dialect = dialectFor(connection.dbType);
  if (!dialect) {
    throw new TargetError('TARGET_ERROR', {
      message: `아직 지원하지 않는 DB 종류입니다: ${connection.dbType}`,
    });
  }
  return {
    dialect,
    // 0001 마이그레이션 전에 등록한 스케줄러는 감지 스키마가 없어 접속의 스키마 설정을 쓴다
    tables: createTableSet(dialect, {
      schema: scheduler.tableSchema ?? connection.schemaName ?? undefined,
      tables: scheduler.tableNames,
    }),
    features: scheduler.features,
    schedName: scheduler.schedName,
  };
}
