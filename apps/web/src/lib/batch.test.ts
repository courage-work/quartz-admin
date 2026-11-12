import type { BatchPreviewItemDto, BatchResultItemDto, CommandNoticeDto } from '@qa/shared';
import { describe, expect, it } from 'vitest';

import {
  batchCommand,
  batchConfirmLabel,
  batchRequest,
  batchResultMessage,
  batchTitle,
  classifyPreviewItem,
  countPreview,
  hasMisfireWarning,
  previewItemReason,
} from './batch';

const key = (name: string) => ({ group: 'g', name });
const expected = (name: string, state: string) => ({
  triggers: [{ group: 'g', name, state }],
  pausedGroups: [],
});

function previewItem(
  name: string,
  opts: { changes?: boolean; blocked?: CommandNoticeDto; warnings?: CommandNoticeDto[] } = {},
): BatchPreviewItemDto {
  return {
    command: { type: 'resumeTrigger', trigger: key(name) },
    preview: {
      targets: [
        {
          ...key(name),
          state: 'PAUSED',
          jobGroup: 'jg',
          jobName: 'j',
          nextFireTime: null,
        },
      ],
      expected: expected(name, 'PAUSED'),
      changes: opts.changes ? [{ ...key(name), from: 'PAUSED', to: 'WAITING' }] : [],
      warnings: opts.warnings ?? [],
      blocked: opts.blocked ?? null,
    },
    error: null,
  };
}

const notFound: BatchPreviewItemDto = {
  command: { type: 'resumeTrigger', trigger: key('gone') },
  preview: null,
  error: { code: 'NOT_FOUND', message: '트리거가 없습니다' },
};

const inPausedGroup: CommandNoticeDto = {
  code: 'RESUME_IN_PAUSED_GROUP',
  message: '그룹을 먼저 재개하세요',
};

describe('일괄 제어 (FR-CTL-10)', () => {
  it('종류와 동작으로 명령을 만든다', () => {
    expect(batchCommand('trigger', 'pause', key('a'))).toEqual({
      type: 'pauseTrigger',
      trigger: key('a'),
    });
    expect(batchCommand('job', 'resume', key('a'))).toEqual({ type: 'resumeJob', job: key('a') });
    expect(batchTitle('job', 'pause', 3)).toBe('잡 3개 일시정지');
    expect(batchConfirmLabel('resume', 2)).toBe('2개 재개하기');
  });

  it('바뀌는 것이 있는 항목만 실행하고, 막힌 항목은 이유를 보여 준다', () => {
    const items = [
      previewItem('run', { changes: true }),
      previewItem('same'),
      previewItem('paused-group', { blocked: inPausedGroup }),
      notFound,
    ];
    expect(items.map(classifyPreviewItem)).toEqual(['run', 'noChange', 'blocked', 'blocked']);
    expect(countPreview(items)).toEqual({ run: 1, noChange: 1, blocked: 2 });
    expect(previewItemReason(items[2]!)).toBe('그룹을 먼저 재개하세요');
    expect(previewItemReason(notFound)).toBe('트리거가 없습니다');
    expect(batchRequest(items)).toEqual({
      items: [
        {
          command: { type: 'resumeTrigger', trigger: key('run') },
          expected: expected('run', 'PAUSED'),
        },
      ],
    });
  });

  it('실행하는 항목에 misfire 위임 경고가 있을 때만 안내한다', () => {
    const misfire: CommandNoticeDto = { code: 'MISFIRE_DELEGATED', message: '' };
    expect(hasMisfireWarning([previewItem('a', { changes: true, warnings: [misfire] })])).toBe(
      true,
    );
    expect(hasMisfireWarning([previewItem('a', { warnings: [misfire] })])).toBe(false);
  });

  it('결과 알림은 바꾼 수와 바뀌지 않은·실패한·건너뛴 수를 알린다', () => {
    const ok = (name: string, changed = true): BatchResultItemDto => ({
      command: { type: 'pauseTrigger', trigger: key(name) },
      status: 'success',
      changed,
      changes: [],
      warnings: [],
      auditId: 1,
    });
    const bad = (status: 'failure' | 'skipped'): BatchResultItemDto => ({
      command: { type: 'pauseTrigger', trigger: key(status) },
      status,
      error: { code: 'X', message: 'x' },
    });
    expect(batchResultMessage('trigger', 'pause', [ok('a'), ok('b')])).toBe(
      '트리거 2개를 일시정지했습니다',
    );
    expect(
      batchResultMessage('trigger', 'pause', [
        ok('a'),
        ok('b', false),
        bad('failure'),
        bad('skipped'),
      ]),
    ).toBe(
      '트리거 1개를 일시정지했습니다. 1개는 바뀐 것이 없습니다, 1개는 실패했습니다, 1개는 실행하지 않았습니다',
    );
    expect(batchResultMessage('job', 'resume', [bad('failure')])).toBe(
      '재개한 잡이 없습니다. 1개는 실패했습니다',
    );
  });
});
