/**
 * 키 교체 후 기존 암호문을 활성 키로 재암호화한다 (TRD §4.1, `cli rotate-keys`)
 *
 * 한 트랜잭션에서 처리한다. 하나라도 복호화하지 못하면 아무것도 바꾸지 않고 실패한다.
 */
import { eq } from 'drizzle-orm';
import type { MetaDb } from '../meta-db/meta-db.js';
import { channels, connections } from '../meta-db/schema.js';
import { SecretDecryptError, secretAad, type SecretBox, type SecretTable } from './secret-box.js';

export interface RotationReport {
  dryRun: boolean;
  activeKeyId: string;
  scanned: number;
  rotated: number;
  alreadyCurrent: number;
}

export interface RotationFailure {
  table: SecretTable;
  id: number;
  reason: string;
}

export class RotationError extends Error {
  readonly failures: RotationFailure[];

  constructor(failures: RotationFailure[]) {
    super(
      `복호화하지 못한 암호문이 ${failures.length}개 있어 아무것도 바꾸지 않았습니다:\n` +
        failures.map((f) => `  - ${f.table}#${f.id}: ${f.reason}`).join('\n'),
    );
    this.name = 'RotationError';
    this.failures = failures;
  }
}

export function rotateSecrets(
  db: MetaDb,
  box: SecretBox,
  options: { dryRun?: boolean } = {},
): RotationReport {
  const dryRun = options.dryRun ?? false;
  const report: RotationReport = {
    dryRun,
    activeKeyId: box.activeKeyId,
    scanned: 0,
    rotated: 0,
    alreadyCurrent: 0,
  };
  const failures: RotationFailure[] = [];

  db.transaction((tx) => {
    const targets = [
      ...tx
        .select({ id: connections.id, token: connections.passwordEnc })
        .from(connections)
        .all()
        .map((r) => ({ table: 'connections' as const, ...r })),
      ...tx
        .select({ id: channels.id, token: channels.configEnc })
        .from(channels)
        .all()
        .map((r) => ({ table: 'channels' as const, ...r })),
    ];

    for (const { table, id, token } of targets) {
      report.scanned++;
      try {
        if (box.isCurrent(token)) {
          report.alreadyCurrent++;
          continue;
        }
        const aad = secretAad(table, id);
        const reencrypted = box.encrypt(box.decrypt(token, aad), aad);
        report.rotated++;
        if (dryRun) continue;
        if (table === 'connections') {
          tx.update(connections)
            .set({ passwordEnc: reencrypted })
            .where(eq(connections.id, id))
            .run();
        } else {
          tx.update(channels).set({ configEnc: reencrypted }).where(eq(channels.id, id)).run();
        }
      } catch (err) {
        if (!(err instanceof SecretDecryptError)) throw err;
        failures.push({ table, id, reason: err.message });
      }
    }

    // 예외를 던지면 drizzle이 트랜잭션을 롤백한다
    if (failures.length > 0) throw new RotationError(failures);
  });

  return report;
}
