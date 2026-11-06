import { parseJavaPropertiesBytes } from '@qa/core';
import type { JobDataDto } from '@qa/shared';

/** Java 직렬화 스트림 매직 넘버 (`ObjectOutputStream.STREAM_MAGIC` 0xACED) */
const JAVA_SERIAL_MAGIC = [0xac, 0xed] as const;

/** `Properties.store`가 쓰는 텍스트에 나올 수 없는 제어 문자(탭, 줄바꿈, 폼피드 제외) */
function hasBinaryBytes(bytes: Buffer): boolean {
  for (const b of bytes) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) return true;
  }
  return false;
}

/**
 * JobDataMap BLOB을 화면용으로 바꾼다 (FR-VIEW-08, TRD §8.3).
 *
 * - Quartz `useProperties=true`면 `java.util.Properties` 텍스트로 저장된다. `@qa/core`로 파싱해 키-값을 돌려준다.
 * - 기본값(`useProperties=false`)은 Java 직렬화이며 클래스 정보 없이는 읽을 수 없어 "표시 불가"로 알린다.
 * - 둘 다 아니면 읽을 수 없는 형식으로 알린다. 원본 바이트는 돌려주지 않는다.
 */
export function describeJobData(bytes: Buffer | null): JobDataDto {
  if (bytes === null || bytes.length === 0) return { format: 'empty' };
  if (bytes[0] === JAVA_SERIAL_MAGIC[0] && bytes[1] === JAVA_SERIAL_MAGIC[1]) {
    return { format: 'java-serialized', bytes: bytes.length };
  }
  if (hasBinaryBytes(bytes)) return { format: 'unreadable', bytes: bytes.length };
  try {
    const map = parseJavaPropertiesBytes(bytes);
    const entries = [...map.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { format: 'properties', entries };
  } catch {
    return { format: 'unreadable', bytes: bytes.length };
  }
}
