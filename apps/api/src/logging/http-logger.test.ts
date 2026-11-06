import { Logger } from '@nestjs/common';
import { Logger as PinoNestLogger } from 'nestjs-pino';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestApp, type TestApp, testLogs } from '../auth/test-support.js';
import { LOG_CENSOR, pinoOptions } from './http-logger.js';

/** 접근 로그는 응답이 끝난 뒤 비동기로 쓰이므로 잠깐 기다린다 */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** 단독 pino 로거의 출력을 JSON으로 모은다 */
function capture() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  };
}

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('pino 설정', () => {
  it('비밀값 경로를 가리고 레벨을 문자열로 남긴다', () => {
    const logs = capture();
    const log = pino(pinoOptions('info'), logs.stream);
    log.info(
      {
        password: 'p1',
        body: { currentPassword: 'p2', newPassword: 'p3', username: 'alice' },
        conn: { passwordEnc: 'v1:x', configEnc: 'v1:y' },
        headers: { authorization: 'Basic abc', cookie: 'qa_sid=secret' },
      },
      'hello',
    );
    const [line] = logs.lines;
    expect(line).toMatchObject({
      level: 'info',
      msg: 'hello',
      password: LOG_CENSOR,
      body: { currentPassword: LOG_CENSOR, newPassword: LOG_CENSOR, username: 'alice' },
      conn: { passwordEnc: LOG_CENSOR, configEnc: LOG_CENSOR },
      headers: { authorization: LOG_CENSOR, cookie: LOG_CENSOR },
    });
    expect(line?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(line)).not.toMatch(/p1|p2|p3|abc|qa_sid=secret|v1:/);
  });

  it('설정한 레벨보다 낮은 로그는 남기지 않는다', () => {
    const logs = capture();
    const log = pino(pinoOptions('warn'), logs.stream);
    log.info('skip');
    log.warn('keep');
    expect(logs.lines.map((l) => l.msg)).toEqual(['keep']);
  });
});

describe('접근 로그 (TRD §11.3)', () => {
  it('요청 ID, 사용자, 경로, 상태, 소요 시간을 JSON 한 줄로 남긴다', async () => {
    t = await createTestApp();
    const login = await t.send('post', '/auth/login', { ...ADMIN }).expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const me = await t.get('/auth/me?x=secret-query', cookie).expect(200);
    await settle();

    const [loginLine, meLine] = testLogs.access();
    expect(loginLine).toMatchObject({
      level: 'info',
      requestId: login.headers['x-request-id'],
      req: { method: 'POST', url: '/api/v1/auth/login' },
      res: { statusCode: 200 },
      msg: 'POST /api/v1/auth/login 200',
    });
    expect(meLine).toMatchObject({
      requestId: me.headers['x-request-id'],
      userId: 1,
      req: { method: 'GET', url: '/api/v1/auth/me' },
    });
    // 요청 본문, 헤더, 쿼리 문자열은 남기지 않는다
    const text = JSON.stringify(testLogs.lines);
    expect(text).not.toContain(ADMIN.password);
    expect(text).not.toContain('qa_sid=');
    expect(text).not.toContain('secret-query');
  });

  it('5xx가 아닌 실패는 info로 남기고, 헬스체크는 남기지 않는다', async () => {
    t = await createTestApp();
    await t.get('/auth/me').expect(401);
    const server = t.app.getHttpServer();
    await request(server).get('/healthz').expect(200);
    await request(server).get('/readyz').expect(200);
    await settle();
    expect(testLogs.access().map((l) => [l.level, l.msg])).toEqual([
      ['info', 'GET /api/v1/auth/me 401'],
    ]);
  });

  it('Nest Logger 출력도 같은 JSON 형식으로 남는다', async () => {
    t = await createTestApp();
    t.app.useLogger(t.app.get(PinoNestLogger));
    new Logger('Probe').warn('경고 메시지');
    await settle();
    expect(testLogs.lines.at(-1)).toMatchObject({
      level: 'warn',
      context: 'Probe',
      msg: '경고 메시지',
    });
  });
});
