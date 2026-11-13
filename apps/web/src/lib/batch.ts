import type {
  BatchCommand,
  BatchPreviewItemDto,
  BatchRequest,
  BatchResultItemDto,
} from '@qa/shared';

/** 일괄 제어 대상의 종류. 트리거 탭은 트리거, 잡 탭은 잡을 고른다 */
export type BatchKind = 'trigger' | 'job';
export type BatchAction = 'pause' | 'resume';

export interface BatchKey {
  group: string;
  name: string;
}

/** 선택 상태의 키. 그룹·이름에 어떤 글자가 와도 겹치지 않게 NUL로 잇는다 */
export const batchKeyId = (key: BatchKey): string => `${key.group}\u0000${key.name}`;

export function batchCommand(kind: BatchKind, action: BatchAction, key: BatchKey): BatchCommand {
  const target = { group: key.group, name: key.name };
  if (kind === 'trigger') {
    return action === 'pause'
      ? { type: 'pauseTrigger', trigger: target }
      : { type: 'resumeTrigger', trigger: target };
  }
  return action === 'pause'
    ? { type: 'pauseJob', job: target }
    : { type: 'resumeJob', job: target };
}

export function batchCommandKey(command: BatchCommand): BatchKey {
  return 'trigger' in command ? command.trigger : command.job;
}

const KIND_LABEL: Record<BatchKind, string> = { trigger: '트리거', job: '잡' };
const ACTION_LABEL: Record<BatchAction, string> = { pause: '일시정지', resume: '재개' };

/** 확인 대화상자 제목 */
export function batchTitle(kind: BatchKind, action: BatchAction, count: number): string {
  return `${KIND_LABEL[kind]} ${count}개 ${ACTION_LABEL[action]}`;
}

/** 실행 버튼 문구. 실제로 실행할 항목 수를 붙인다(DESIGN §10) */
export function batchConfirmLabel(action: BatchAction, runCount: number): string {
  return `${runCount}개 ${ACTION_LABEL[action]}하기`;
}

/**
 * 미리보기 항목을 어떻게 처리할지.
 * - `run`: 바뀌는 트리거가 있어 실행한다
 * - `noChange`: 바뀌는 것이 없어 보내지 않는다(이미 일시정지된 트리거의 일시정지 등)
 * - `blocked`: 실행할 수 없다(없어진 대상, 일시정지된 그룹 안의 지난 트리거 재개 등). 이유를 보여 주고 보내지 않는다
 */
export type BatchPreviewClass = 'run' | 'noChange' | 'blocked';

export function classifyPreviewItem(item: BatchPreviewItemDto): BatchPreviewClass {
  if (item.error || !item.preview || item.preview.blocked) return 'blocked';
  return item.preview.changes.length > 0 ? 'run' : 'noChange';
}

/** 실행 못 하는 항목의 이유 */
export function previewItemReason(item: BatchPreviewItemDto): string | null {
  return item.error?.message ?? item.preview?.blocked?.message ?? null;
}

export function countPreview(
  items: readonly BatchPreviewItemDto[],
): Record<BatchPreviewClass, number> {
  const counts = { run: 0, noChange: 0, blocked: 0 };
  for (const it of items) counts[classifyPreviewItem(it)]++;
  return counts;
}

/** 실행 요청. 바뀌는 것이 있는 항목만 미리보기의 기대 상태를 붙여 보낸다 */
export function batchRequest(items: readonly BatchPreviewItemDto[]): BatchRequest {
  return {
    items: items.flatMap((it) =>
      classifyPreviewItem(it) === 'run' && it.preview
        ? [{ command: it.command, expected: it.preview.expected }]
        : [],
    ),
  };
}

/** 실행 결과 항목의 분류. 성공했지만 바뀐 것이 없으면(그 사이 다른 사용자가 바꿈) `unchanged` */
export type BatchResultClass = 'changed' | 'unchanged' | 'failure' | 'skipped';

export function classifyResultItem(item: BatchResultItemDto): BatchResultClass {
  if (item.status === 'success') return item.changed ? 'changed' : 'unchanged';
  return item.status;
}

export function countResult(
  items: readonly BatchResultItemDto[],
): Record<BatchResultClass, number> {
  const counts = { changed: 0, unchanged: 0, failure: 0, skipped: 0 };
  for (const it of items) counts[classifyResultItem(it)]++;
  return counts;
}

/** 결과 알림 문구 (NFR-UX-03). 실패가 있으면 몇 개인지 붙인다 */
export function batchResultMessage(
  kind: BatchKind,
  action: BatchAction,
  items: readonly BatchResultItemDto[],
): string {
  const c = countResult(items);
  const subject = KIND_LABEL[kind];
  const done =
    c.changed > 0
      ? `${subject} ${c.changed}개를 ${ACTION_LABEL[action]}했습니다`
      : `${ACTION_LABEL[action]}한 ${kind === 'trigger' ? '트리거가' : '잡이'} 없습니다`;
  const rest = [
    c.unchanged > 0 ? `${c.unchanged}개는 바뀐 것이 없습니다` : null,
    c.failure > 0 ? `${c.failure}개는 실패했습니다` : null,
    c.skipped > 0 ? `${c.skipped}개는 실행하지 않았습니다` : null,
  ].filter((v) => v !== null);
  return rest.length > 0 ? `${done}. ${rest.join(', ')}` : done;
}

/** 재개한 트리거 중 실행 시각이 지난 것이 있는지. 있으면 misfire 처리 안내를 붙인다 (TRD §7.4) */
export function hasMisfireWarning(items: readonly BatchPreviewItemDto[]): boolean {
  return items.some(
    (it) =>
      classifyPreviewItem(it) === 'run' &&
      it.preview?.warnings.some((w) => w.code === 'MISFIRE_DELEGATED'),
  );
}
