import { createTableSet } from '../../src/table-set.js';
import type { SchedulerCommandContext } from '../../src/commands/types.js';
import type { DbFixture } from './db.js';
import { quartzCatalogNames, type QuartzSchemaOptions } from './quartz-schema.js';

/** Quartz 2.x 스키마(Oracle, PostgreSQL 배포본 모두)의 선택 테이블·컬럼이 다 있다 */
export const FULL_FEATURES = {
  simpropTriggers: true,
  triggerPriority: true,
  firedPriority: true,
  firedSchedTime: true,
  jobNonconcurrent: true,
  jobUpdateData: true,
  cronTimeZone: true,
} as const;

/**
 * 테스트 DB의 스케줄러 하나에 대한 조회·명령 컨텍스트. 테이블 이름은 DB가 저장한 실제 이름(Oracle 대문자,
 * PostgreSQL 소문자)을 쓴다. 자동 감지 결과와 같은 값이다.
 */
export function schedulerContext(
  db: DbFixture,
  schedName: string,
  schema: QuartzSchemaOptions = {},
): SchedulerCommandContext {
  return {
    dialect: db.dialect,
    tables: createTableSet(db.dialect, { schema: db.schema, tables: quartzCatalogNames(schema) }),
    features: FULL_FEATURES,
    schedName,
  };
}
