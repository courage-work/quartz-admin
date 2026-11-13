import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp } from '../auth/test-support.js';
import { MetaDbService } from '../meta-db/meta-db.service.js';
import { csvField } from './csv.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BOM = String.fromCharCode(0xfeff);
const CR = '\r';
const LF = '\n';

/** 테스트용 기록을 바로 넣는다(앱 코드가 아니라 테스트 준비) */
function insertLog(app: TestApp, row: Record<string, unknown> = {}): void {
  const values: Record<string, unknown> = {
    at: app.clock.now,
    user_id: null,
    username: 'alice',
    ip: '10.0.0.1',
    request_id: null,
    action: 'trigger.pause',
    target_type: 'trigger',
    target: JSON.stringify({ schedName: 'S', trigger: { group: 'g', name: 't' } }),
    connection_id: null,
    scheduler_id: null,
    before: null,
    after: null,
    result: 'success',
    error_code: null,
    error_message: null,
    reason: null,
    ...row,
  };
  const cols = Object.keys(values);
  app.app
    .get(MetaDbService)
    .sqlite.prepare(
      `INSERT INTO audit_logs (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    )
    .run(values);
}

/** RFC 4180 CSV를 줄·칸으로 나눈다(따옴표 안의 쉼표·줄바꿈 포함) */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === CR && text[i + 1] === LF) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

async function exportCsv(app: TestApp, cookie: string, query = '') {
  const res = await app.get(`/audit-logs/export.csv${query}`, cookie).expect(200);
  const text = res.text;
  return { res, text, rows: parseCsv(text.startsWith(BOM) ? text.slice(1) : text) };
}

describe('CSV 칸 (FR-AUD-05)', () => {
  it('쉼표·따옴표·줄바꿈은 따옴표로 감싸고, 수식으로 시작하는 글은 앞에 작은따옴표를 붙인다', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(12)).toBe('12');
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(`line1${LF}line2`)).toBe(`"line1${LF}line2"`);
    for (const lead of ['=', '+', '-', '@', '\t', CR]) {
      expect(csvField(`${lead}1`).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvField(-1)).toBe('-1');
  });
});

describe('CSV 내보내기 API (FR-AUD-05)', () => {
  it('BOM·머리글·파일 이름을 주고, 필터를 반영하며, 특수 문자와 수식을 안전하게 쓴다', async () => {
    const app = (t = await createTestApp());
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const message = `상태가 달라, "다시" 실행하세요${LF}둘째 줄`;
    insertLog(app, {
      username: '=HYPERLINK("http://x")',
      result: 'failure',
      error_code: 'STATE_CONFLICT',
      error_message: message,
      before: JSON.stringify({ command: { type: 'pauseTrigger' } }),
    });
    insertLog(app, { username: '-1+2', action: 'trigger.resume', result: 'failure' });
    insertLog(app, { username: 'bob' });

    const { res, text, rows } = await exportCsv(app, admin, '?result=failure&action=trigger.pause');
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-logs-\d{8}-\d{6}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(text.startsWith(`${BOM}id,`)).toBe(true);
    expect(rows[0]).toEqual([
      'id',
      '시각(UTC)',
      '사용자',
      'IP',
      '요청 ID',
      '작업',
      '대상 종류',
      '대상',
      '접속 ID',
      '스케줄러 ID',
      '결과',
      '오류 코드',
      '오류 메시지',
      '사유',
      '변경 전',
      '변경 후',
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual([
      expect.stringMatching(/^\d+$/) as unknown as string,
      new Date(app.clock.now).toISOString(),
      // 수식으로 실행되지 않게 앞에 작은따옴표를 붙인다
      `'=HYPERLINK("http://x")`,
      '10.0.0.1',
      '',
      'trigger.pause',
      'trigger',
      '{"schedName":"S","trigger":{"group":"g","name":"t"}}',
      '',
      '',
      'failure',
      'STATE_CONFLICT',
      message,
      '',
      '{"command":{"type":"pauseTrigger"}}',
      '',
    ]);

    const resumed = await exportCsv(app, admin, '?action=trigger.resume');
    expect(resumed.rows[1]?.[2]).toBe("'-1+2");
  });

  it('묶음(1,000건)을 넘는 기록도 최신순으로 빠짐없이 내보낸다', async () => {
    const app = (t = await createTestApp());
    const admin = await app.login(ADMIN.username, ADMIN.password);
    app.app.get(MetaDbService).sqlite.transaction(() => {
      for (let i = 0; i < 2_500; i++) insertLog(app, { username: `user${i}` });
    })();
    const { rows } = await exportCsv(app, admin, '?action=trigger.pause');
    const ids = rows.slice(1).map((r) => Number(r[0]));
    expect(ids).toHaveLength(2_500);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(2_500);
    expect(rows[1]?.[2]).toBe('user2499');
    expect(rows.at(-1)?.[2]).toBe('user0');
  });

  it('로그인해야 하고, 맞는 기록이 없으면 머리글만 주며, 잘못된 쿼리는 400이다', async () => {
    const app = (t = await createTestApp());
    await app.get('/audit-logs/export.csv').expect(401);
    const admin = await app.login(ADMIN.username, ADMIN.password);
    const { rows } = await exportCsv(app, admin, '?action=job.delete');
    expect(rows).toHaveLength(1);
    for (const q of ['?from=10&to=10', '?action=drop.table', '?userId=abc']) {
      const res = await app.get(`/audit-logs/export.csv${q}`, admin).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});
