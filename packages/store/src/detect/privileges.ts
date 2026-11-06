import type { TargetConn } from '../adapter.js';
import { TargetError } from '../errors.js';
import type { QuartzTableKey } from '../quartz-tables.js';
import type { TableSet } from '../table-set.js';
import type { MissingPrivilege, TablePrivilege } from './types.js';

/**
 * 도구의 쓰기 명령(B-17~B-23)에 필요한 권한 (TRD §5.5 6단계).
 * 잠금 행 SELECT … FOR UPDATE에는 LOCKS의 UPDATE 권한이 필요하다.
 */
export const REQUIRED_PRIVILEGES: Readonly<Record<QuartzTableKey, readonly TablePrivilege[]>> = {
  TRIGGERS: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  SIMPLE_TRIGGERS: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  CRON_TRIGGERS: ['SELECT', 'UPDATE', 'DELETE'],
  SIMPROP_TRIGGERS: ['SELECT', 'DELETE'],
  BLOB_TRIGGERS: ['SELECT', 'DELETE'],
  JOB_DETAILS: ['SELECT', 'DELETE'],
  PAUSED_TRIGGER_GRPS: ['SELECT', 'INSERT', 'DELETE'],
  LOCKS: ['SELECT', 'INSERT', 'UPDATE'],
  FIRED_TRIGGERS: ['SELECT'],
  SCHEDULER_STATE: ['SELECT'],
  CALENDARS: ['SELECT'],
};

/** 결과 행이 0개인 문장. 권한 검사는 실행 단계에서 일어나므로 행을 건드리지 않고 권한 유무를 알 수 있다 */
function probeSql(table: string, privilege: TablePrivilege): string {
  switch (privilege) {
    case 'SELECT':
      return `SELECT 1 FROM ${table} WHERE 1 = 0`;
    case 'INSERT':
      return `INSERT INTO ${table} SELECT * FROM ${table} WHERE 1 = 0`;
    case 'UPDATE':
      return `UPDATE ${table} SET SCHED_NAME = SCHED_NAME WHERE 1 = 0`;
    case 'DELETE':
      return `DELETE FROM ${table} WHERE 1 = 0`;
  }
}

/**
 * 쓰기 권한 점검 (FR-CON-04). 모든 문장을 실행한 뒤 ROLLBACK하므로 대상 DB에는 아무것도 남지 않는다.
 *
 * 실패한 문장 하나마다 바로 ROLLBACK한다. Oracle은 실패한 문장만 되돌리지만, PostgreSQL은 트랜잭션 전체가
 * 중단돼 다음 문장이 실패하므로 DB 4종에서 같은 결과를 얻기 위해서다.
 * 연결이 끊기거나 시간이 넘으면 판정할 수 없으므로 오류를 그대로 던진다.
 */
export async function checkWritePrivileges(
  conn: TargetConn,
  tables: TableSet,
): Promise<MissingPrivilege[]> {
  const missing: MissingPrivilege[] = [];
  try {
    for (const [key, privileges] of Object.entries(REQUIRED_PRIVILEGES) as [
      QuartzTableKey,
      readonly TablePrivilege[],
    ][]) {
      if (!tables.has(key)) continue;
      const table = tables.table(key);
      for (const privilege of privileges) {
        try {
          if (privilege === 'SELECT') await conn.query(probeSql(table, privilege));
          else await conn.execute(probeSql(table, privilege));
        } catch (err) {
          if (!(err instanceof TargetError) || err.code !== 'TARGET_ERROR') throw err;
          missing.push({ table: key, privilege, driverCode: err.driverCode });
          await conn.rollback();
        }
      }
    }
  } finally {
    await conn.rollback();
  }
  return missing;
}
