import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type {
  AlertCenterPage,
  AlertSummaryDto,
  AuditLogPage,
  ChannelDto,
  ChannelsResponse,
  ChannelTestResult,
  DeliveryFailureDto,
} from '@qa/shared';
import { isAllowedWebhookUrl } from '@qa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../auth/test-support.js';
import { AlertCenterService } from './alert-center.service.js';
import { MAX_ATTEMPTS, RETRY_BACKOFF_MS } from './notification-worker.js';
import { addScheduler, FakeTarget, MIN, startAlertsApp, type AlertsApp } from './test-support.js';

// ── 가짜 Slack·SMTP 서버 ─────────────────────────────────────────

interface FakeSlack {
  url: string;
  bodies: { text: string; attachments: { color: string; blocks: unknown[] }[] }[];
  mode: 'ok' | 'error' | 'hang';
  close: () => Promise<void>;
}

async function startFakeSlack(): Promise<FakeSlack> {
  const state = { mode: 'ok' as FakeSlack['mode'] };
  const bodies: FakeSlack['bodies'] = [];
  const server: Server = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      if (state.mode === 'hang') return; // 응답하지 않는다
      bodies.push(JSON.parse(raw) as FakeSlack['bodies'][number]);
      if (state.mode === 'error') {
        res.writeHead(500).end('invalid_payload');
        return;
      }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/services/T000/B000/XyZ9`,
    bodies,
    get mode() {
      return state.mode;
    },
    set mode(m) {
      state.mode = m;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface FakeSmtp {
  port: number;
  messages: { to: string[]; data: string }[];
  /** RCPT를 거부한다 */
  reject: boolean;
  close: () => Promise<void>;
}

/** nodemailer가 쓰는 만큼만 답하는 SMTP 서버(STARTTLS·AUTH 없음) */
async function startFakeSmtp(): Promise<FakeSmtp> {
  const fake = { messages: [] as FakeSmtp['messages'], reject: false };
  const server: TcpServer = createTcpServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let current = { to: [] as string[], data: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            fake.messages.push(current);
            current = { to: [], data: '' };
            sock.write('250 OK queued\r\n');
          } else {
            current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL' || cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
        else if (cmd === 'RCPT') {
          if (fake.reject) sock.write('550 5.1.1 no such user\r\n');
          else {
            current.to.push(line.replace(/^RCPT TO:\s*/i, ''));
            sock.write('250 OK\r\n');
          }
        } else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 go ahead\r\n');
        } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('502 not implemented\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return Object.assign(fake, {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}

// ── 준비 ─────────────────────────────────────────────────────────

let t: TestApp | undefined;
let slack: FakeSlack | undefined;
let smtp: FakeSmtp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  await slack?.close();
  slack = undefined;
  await smtp?.close();
  smtp = undefined;
});

async function start(fake = new FakeTarget(), withSmtp = true) {
  slack = await startFakeSlack();
  smtp = await startFakeSmtp();
  const started = await startAlertsApp(fake, {
    ...(withSmtp
      ? {
          config: {
            smtp: { host: '127.0.0.1', port: smtp.port, from: 'qa@example.com', secure: false },
          },
        }
      : {}),
  });
  t = started.app;
  return { ...started, fake, slack, smtp };
}

async function createChannel(a: AlertsApp, body: object): Promise<ChannelDto> {
  return (await a.app.send('post', '/channels', body, await a.session()).expect(201))
    .body as ChannelDto;
}

/** TRIGGER_ERROR 규칙을 주어진 채널로만 보내게 한다 */
async function routeErrorsTo(a: AlertsApp, schedulerId: number, channelIds: number[]) {
  const rule = (await a.rules(schedulerId)).find((r) => r.type === 'TRIGGER_ERROR')!;
  await a.app
    .send('put', `/alert-rules/${rule.id}`, { ...rule, channelIds }, await a.session())
    .expect(200);
}

function notificationRows(a: AlertsApp) {
  return a.sqlite
    .prepare(
      `SELECT n.id, c.type AS channel, n.event, n.status, n.attempts, n.next_attempt_at AS next, n.last_error AS error
       FROM notifications n JOIN channels c ON c.id = n.channel_id ORDER BY n.id`,
    )
    .all() as {
    id: number;
    channel: string;
    event: string;
    status: string;
    attempts: number;
    next: number;
    error: string | null;
  }[];
}

// ── 테스트 ───────────────────────────────────────────────────────

describe('웹훅 URL 검사', () => {
  it('https만 받고, http는 로컬 개발·테스트용 localhost만', () => {
    expect(isAllowedWebhookUrl('https://hooks.slack.com/services/T/B/x')).toBe(true);
    expect(isAllowedWebhookUrl('http://localhost:9000/hook')).toBe(true);
    expect(isAllowedWebhookUrl('http://127.0.0.1:9000/hook')).toBe(true);
    expect(isAllowedWebhookUrl('http://hooks.slack.com/services/T/B/x')).toBe(false);
    expect(isAllowedWebhookUrl('https://user:pw@hooks.slack.com/x')).toBe(false);
    expect(isAllowedWebhookUrl('ftp://example.com')).toBe(false);
    expect(isAllowedWebhookUrl('not a url')).toBe(false);
  });
});

describe('채널 관리 (FR-ALT-07)', () => {
  it('추가·수정·삭제. 웹훅 URL은 응답과 감사 기록에 남기지 않는다', async () => {
    const a = await start();
    const s = await createChannel(a, {
      type: 'slack',
      name: '운영 Slack',
      enabled: true,
      webhookUrl: a.slack.url,
    });
    expect(s).toMatchObject({
      type: 'slack',
      name: '운영 Slack',
      ruleCount: 0,
      lastDelivery: null,
    });
    expect(s.target).toBe(`127.0.0.1:${new URL(a.slack.url).port}/…/XyZ9`);
    expect(JSON.stringify(s)).not.toContain('/services/T000');

    // 추가에는 웹훅 URL이 필요하고 https여야 한다
    await a.app
      .send('post', '/channels', { type: 'slack', name: 'x', enabled: true }, a.cookie)
      .expect(400);
    const http = await a.app
      .send(
        'post',
        '/channels',
        { type: 'slack', name: 'x', enabled: true, webhookUrl: 'http://hooks.slack.com/x' },
        a.cookie,
      )
      .expect(400);
    expect(http.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    // 비우고 저장하면 웹훅 URL은 그대로
    const renamed = (
      await a.app
        .send(
          'put',
          `/channels/${s.id}`,
          { type: 'slack', name: '배치 Slack', enabled: true, webhookUrl: '' },
          a.cookie,
        )
        .expect(200)
    ).body as ChannelDto;
    expect(renamed).toMatchObject({ name: '배치 Slack', target: s.target });
    // 종류는 바꿀 수 없다
    await a.app
      .send(
        'put',
        `/channels/${s.id}`,
        { type: 'email', name: 'x', enabled: true, recipients: ['a@b.co'] },
        a.cookie,
      )
      .expect(400);

    const e = await createChannel(a, {
      type: 'email',
      name: '운영 메일',
      enabled: true,
      recipients: ['ops@example.com', 'oncall@example.com'],
    });
    expect(e).toMatchObject({
      target: 'ops@example.com, oncall@example.com',
      recipients: ['ops@example.com', 'oncall@example.com'],
    });

    const list = (await a.app.get('/channels', a.cookie).expect(200)).body as ChannelsResponse;
    expect(list.smtpConfigured).toBe(true);
    // 인앱이 먼저, 나머지는 이름순. 기본 규칙 6종은 인앱에 연결돼 있다
    expect(list.channels.map((c) => [c.type, c.name])).toEqual([
      ['inapp', '인앱 알림'],
      ['slack', '배치 Slack'],
      ['email', '운영 메일'],
    ]);
    const inapp = list.channels[0]!;
    // 인앱 채널은 바꾸거나 지울 수 없다
    await a.app
      .send(
        'put',
        `/channels/${inapp.id}`,
        { type: 'slack', name: 'x', enabled: true, webhookUrl: a.slack.url },
        a.cookie,
      )
      .expect(409);
    await a.app.send('delete', `/channels/${inapp.id}`, undefined, a.cookie).expect(409);

    await a.app.send('delete', `/channels/${e.id}`, undefined, a.cookie).expect(204);
    await a.app.get(`/channels/${e.id}`, a.cookie).expect(404);

    const logs = (await a.app.get('/audit-logs?action=channel.update', a.cookie).expect(200))
      .body as AuditLogPage;
    // 최근 순: 인앱 수정(409), 종류 변경(400), 이름 변경
    expect(logs.items.map((l) => [l.result, l.targetType])).toEqual([
      ['failure', 'channel'],
      ['failure', 'channel'],
      ['success', 'channel'],
    ]);
    const all = JSON.stringify(
      ((await a.app.get('/audit-logs', a.cookie).expect(200)).body as AuditLogPage).items,
    );
    expect(all).not.toContain('/services/T000');
  });

  it('테스트 발송: Slack·이메일로 예시 알림을 보내고, 실패하면 이유를 돌려준다', async () => {
    const a = await start();
    const s = await createChannel(a, {
      type: 'slack',
      name: 'Slack',
      enabled: true,
      webhookUrl: a.slack.url,
    });
    const ok = (await a.app.send('post', `/channels/${s.id}/test`, undefined, a.cookie).expect(200))
      .body as ChannelTestResult;
    expect(ok).toMatchObject({ ok: true });
    expect(a.slack.bodies[0]?.text).toContain('테스트 발송');

    a.slack.mode = 'error';
    const failed = (
      await a.app.send('post', `/channels/${s.id}/test`, undefined, a.cookie).expect(200)
    ).body as ChannelTestResult;
    expect(failed).toEqual({
      ok: false,
      message: 'Slack이 500로 응답했습니다: invalid_payload',
      durationMs: expect.any(Number) as number,
    });

    const e = await createChannel(a, {
      type: 'email',
      name: '메일',
      enabled: true,
      recipients: ['ops@example.com'],
    });
    expect(
      (
        (await a.app.send('post', `/channels/${e.id}/test`, undefined, a.cookie).expect(200))
          .body as ChannelTestResult
      ).ok,
    ).toBe(true);
    expect(a.smtp.messages[0]?.to).toEqual(['<ops@example.com>']);
    expect(a.smtp.messages[0]?.data).toContain('Subject:');

    a.smtp.reject = true;
    const rejected = (
      await a.app.send('post', `/channels/${e.id}/test`, undefined, a.cookie).expect(200)
    ).body as ChannelTestResult;
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain('SMTP 서버가 거부했습니다');
  });

  it('SMTP를 설정하지 않으면 이메일 채널은 만들 수 있지만 보내지 못한다', async () => {
    const a = await start(new FakeTarget(), false);
    const list = (await a.app.get('/channels', a.cookie).expect(200)).body as ChannelsResponse;
    expect(list.smtpConfigured).toBe(false);
    const e = await createChannel(a, {
      type: 'email',
      name: '메일',
      enabled: true,
      recipients: ['ops@example.com'],
    });
    const res = (
      await a.app.send('post', `/channels/${e.id}/test`, undefined, a.cookie).expect(200)
    ).body as ChannelTestResult;
    expect(res).toMatchObject({
      ok: false,
      message: 'SMTP를 설정하지 않았습니다(QA_SMTP_HOST, QA_SMTP_FROM)',
    });
  });
});

describe('발송 큐 워커 (TRD §9.4)', () => {
  it('조건이 생긴 감시 회차 다음 워커 회차에 Slack·이메일·인앱으로 보낸다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    const s = await createChannel(a, {
      type: 'slack',
      name: 'Slack',
      enabled: true,
      webhookUrl: a.slack.url,
    });
    const e = await createChannel(a, {
      type: 'email',
      name: '메일',
      enabled: true,
      recipients: ['ops@example.com'],
    });
    const inapp = ((await a.app.get('/channels', a.cookie)).body as ChannelsResponse).channels[0]!;
    await routeErrorsTo(a, sch.id, [inapp.id, s.id, e.id]);

    a.fake.errors = [{ group: 'billing', name: 'nightly' }];
    await a.poll(sch.id);
    expect(notificationRows(a).map((r) => [r.channel, r.status])).toEqual([
      ['inapp', 'pending'],
      ['slack', 'pending'],
      ['email', 'pending'],
    ]);
    expect(await a.tick()).toEqual({ sent: 3, retried: 0, failed: 0 });
    expect(notificationRows(a).every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);

    const body = a.slack.bodies[0]!;
    expect(body.text).toBe('[심각] S · ERROR 트리거 발생');
    expect(body.attachments[0]?.color).toBe('#d92d20');
    expect(JSON.stringify(body)).toContain('billing.nightly');
    expect(JSON.stringify(body)).toContain(`/scheduler?id=${sch.id}&tab=alerts`);
    expect(a.smtp.messages).toHaveLength(1);
    expect(a.smtp.messages[0]?.data).toContain('billing.nightly');

    // 해소도 보낸다
    a.fake.errors = [];
    await a.poll(sch.id);
    await a.tick();
    expect(a.slack.bodies.at(-1)?.text).toBe('[심각] S · ERROR 트리거 해소');
    expect(a.slack.bodies.at(-1)?.attachments[0]?.color).toBe('#12b76a');

    const channels = ((await a.app.get('/channels', a.cookie)).body as ChannelsResponse).channels;
    expect(channels.find((c) => c.id === s.id)).toMatchObject({
      ruleCount: 1,
      lastDelivery: { ok: true, error: null },
    });
  });

  it('실패하면 30초, 2분, 10분 뒤 다시 시도하고 네 번째도 실패하면 failed로 두고 인앱에 알린다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    const s = await createChannel(a, {
      type: 'slack',
      name: 'Slack',
      enabled: true,
      webhookUrl: a.slack.url,
    });
    await routeErrorsTo(a, sch.id, [s.id]);
    a.slack.mode = 'error';
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(await a.tick()).toEqual({ sent: 0, retried: 1, failed: 0 });
      const [row] = notificationRows(a);
      expect(row).toMatchObject({
        status: 'pending',
        attempts: attempt,
        error: 'Slack이 500로 응답했습니다: invalid_payload',
      });
      expect(row!.next).toBe(a.app.clock.now + RETRY_BACKOFF_MS[attempt - 1]!);
      // 시각이 되기 전에는 다시 보내지 않는다
      expect(await a.tick()).toEqual({ sent: 0, retried: 0, failed: 0 });
      a.app.clock.advance(RETRY_BACKOFF_MS[attempt - 1]!);
    }
    expect(await a.tick()).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(notificationRows(a)[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(a.slack.bodies).toHaveLength(MAX_ATTEMPTS);

    const summary = (await a.app.get('/alerts/summary', await a.session()).expect(200))
      .body as AlertSummaryDto;
    expect(summary.failedDeliveries).toBe(1);
    const failures = (
      (await a.app.get('/alerts/delivery-failures', await a.session()).expect(200)).body as {
        items: DeliveryFailureDto[];
      }
    ).items;
    expect(failures[0]).toMatchObject({
      alertType: 'TRIGGER_ERROR',
      channelName: 'Slack',
      event: 'fire',
      attempts: MAX_ATTEMPTS,
      lastError: 'Slack이 500로 응답했습니다: invalid_payload',
    });
  });

  it('한 회차에 같은 채널로 6건 넘게 나가면 요약 하나로 보낸다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    const s = await createChannel(a, {
      type: 'slack',
      name: 'Slack',
      enabled: true,
      webhookUrl: a.slack.url,
    });
    await routeErrorsTo(a, sch.id, []);
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);
    const alertId = (a.sqlite.prepare('SELECT id FROM alerts').get() as { id: number }).id;
    const insert = a.sqlite.prepare(
      `INSERT INTO notifications (alert_id, channel_id, event, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, 'reminder', 'pending', 0, ?, ?)`,
    );
    for (let i = 0; i < 6; i++) insert.run(alertId, s.id, a.app.clock.now, a.app.clock.now);

    expect(await a.tick()).toEqual({ sent: 6, retried: 0, failed: 0 });
    expect(a.slack.bodies).toHaveLength(1);
    expect(a.slack.bodies[0]?.text).toBe('quartz-admin 알림 6건');
    expect(JSON.stringify(a.slack.bodies[0])).toContain('/alerts|알림 센터에서 보기');

    // 5건이면 묶지 않는다
    for (let i = 0; i < 5; i++) insert.run(alertId, s.id, a.app.clock.now, a.app.clock.now);
    await a.tick();
    expect(a.slack.bodies).toHaveLength(6);
  });

  it('Slack이 응답하지 않아도 감시는 밀리지 않고, 발송은 제한 시간 뒤 다시 시도로 미룬다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    const s = await createChannel(a, {
      type: 'slack',
      name: 'Slack',
      enabled: true,
      webhookUrl: a.slack.url,
    });
    await routeErrorsTo(a, sch.id, [s.id]);
    a.slack.mode = 'hang';
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);

    const tick = a.tick();
    const started = Date.now();
    a.fake.errors.push({ group: 'g', name: 'worse' });
    await a.poll(sch.id);
    // 테스트 앱의 발송 제한은 2초. 감시는 그보다 훨씬 빨리 끝난다
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await tick).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(notificationRows(a)[0]?.error).toBe('Slack이 2초 안에 응답하지 않았습니다');
  });

  it('채널을 끄면 아직 보내지 않은 발송을 버린다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    const s = await createChannel(a, {
      type: 'slack',
      name: 'Slack',
      enabled: true,
      webhookUrl: a.slack.url,
    });
    await routeErrorsTo(a, sch.id, [s.id]);
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);
    expect(notificationRows(a)).toHaveLength(1);
    await a.app
      .send('put', `/channels/${s.id}`, { type: 'slack', name: 'Slack', enabled: false }, a.cookie)
      .expect(200);
    expect(notificationRows(a)).toEqual([]);
    expect(await a.tick()).toEqual({ sent: 0, retried: 0, failed: 0 });
  });
});

describe('규칙의 채널 선택 (FR-ALT-06)', () => {
  it('고른 채널로만 보내고, 하나도 고르지 않으면 기록만 한다. 없는 채널은 400', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    const created = (
      await a.app
        .send(
          'post',
          `/schedulers/${sch.id}/alert-rules`,
          {
            type: 'OVERDUE',
            scope: { kind: 'all' },
            severity: 'warning',
            renotifyMinutes: null,
            enabled: true,
            channelIds: [],
          },
          a.cookie,
        )
        .expect(201)
    ).body as { channelIds: number[] };
    expect(created.channelIds).toEqual([]);
    await a.app
      .send(
        'post',
        `/schedulers/${sch.id}/alert-rules`,
        {
          type: 'OVERDUE',
          scope: { kind: 'all' },
          severity: 'warning',
          renotifyMinutes: null,
          enabled: true,
          channelIds: [999],
        },
        a.cookie,
      )
      .expect(400);

    await routeErrorsTo(a, sch.id, []);
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);
    expect((await a.alerts(sch.id)).open).toHaveLength(1);
    expect(notificationRows(a)).toEqual([]);
  });
});

describe('알림 센터 (FR-ALT-07)', () => {
  it('읽지 않은 수는 사용자마다 세고, 새 발송이 오면 다시 읽지 않음이 된다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);

    const summary = async (cookie: string) =>
      (await a.app.get('/alerts/summary', cookie).expect(200)).body as AlertSummaryDto;
    const page = async (cookie: string, status = 'active') =>
      (await a.app.get(`/alerts?status=${status}`, cookie).expect(200)).body as AlertCenterPage;

    expect(await summary(a.cookie)).toEqual({ unread: 1, open: 1, failedDeliveries: 0 });
    const [item] = (await page(a.cookie)).items;
    expect(item).toMatchObject({
      type: 'TRIGGER_ERROR',
      status: 'open',
      unread: true,
      schedulerName: 'S',
      envLabel: 'dev',
      notified: true,
    });

    // 다른 사용자
    await a.app
      .send(
        'post',
        '/users',
        { username: 'operator', password: 'Operator!2345', isAdmin: false },
        a.cookie,
      )
      .expect(201);
    const other = await a.app.login('operator', 'Operator!2345');

    await a.app.send('post', `/alerts/${item!.id}/read`, undefined, a.cookie).expect(204);
    expect((await summary(a.cookie)).unread).toBe(0);
    expect((await summary(other)).unread).toBe(1);

    // 대상이 늘어 update가 나가면 다시 읽지 않음
    a.app.clock.advance(1_000);
    a.fake.errors.push({ group: 'g', name: 'worse' });
    await a.poll(sch.id);
    expect((await summary(a.cookie)).unread).toBe(1);
    expect(
      (
        (await a.app.send('post', '/alerts/read-all', undefined, a.cookie).expect(200)).body as {
          changed: number;
        }
      ).changed,
    ).toBe(1);
    expect((await summary(a.cookie)).unread).toBe(0);
  });

  it('확인하면 재알림을 멈추고 확인한 사람을 남기며, 해소된 알림은 확인할 수 없다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);
    const id = ((await a.app.get('/alerts', a.cookie)).body as AlertCenterPage).items[0]!.id;

    expect(
      (
        (await a.app.send('post', `/alerts/${id}/ack`, undefined, a.cookie).expect(200)).body as {
          changed: boolean;
        }
      ).changed,
    ).toBe(true);
    const acked = ((await a.app.get('/alerts', a.cookie)).body as AlertCenterPage).items[0]!;
    expect(acked).toMatchObject({ status: 'acked', ackedBy: 'admin', unread: false });
    // 두 번 확인해도 그대로
    expect(
      (
        (await a.app.send('post', `/alerts/${id}/ack`, undefined, a.cookie).expect(200)).body as {
          changed: boolean;
        }
      ).changed,
    ).toBe(false);

    // 재알림 간격(60분)이 지나도 보내지 않는다
    a.app.clock.advance(61 * MIN);
    await a.poll(sch.id);
    expect(a.events()).toEqual(['TRIGGER_ERROR:fire']);

    a.fake.errors = [];
    await a.poll(sch.id);
    expect(a.events()).toEqual(['TRIGGER_ERROR:fire', 'TRIGGER_ERROR:resolve']);
    const res = await a.app
      .send('post', `/alerts/${id}/ack`, undefined, await a.session())
      .expect(409);
    expect(res.body).toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });
    const resolved = (
      (await a.app.get('/alerts?status=resolved', await a.session())).body as AlertCenterPage
    ).items;
    expect(resolved.map((r) => r.id)).toEqual([id]);

    const logs = (await a.app.get('/audit-logs?action=alert.ack', await a.session()).expect(200))
      .body as AuditLogPage;
    expect(logs.items.map((l) => l.result)).toEqual(['failure', 'success', 'success']);
  });

  it('해소한 지 보존 기간이 지난 알림과 끝난 발송 기록을 지운다', async () => {
    const a = await start();
    const sch = await addScheduler(a.app, a.cookie);
    a.fake.errors = [{ group: 'g', name: 'bad' }];
    await a.poll(sch.id);
    a.fake.errors = [];
    await a.poll(sch.id);
    await a.tick();
    const center = a.app.app.get(AlertCenterService);
    expect(center.prune(a.app.clock.now + 89 * 24 * 60 * MIN)).toBe(0);
    expect(center.prune(a.app.clock.now + 91 * 24 * 60 * MIN)).toBeGreaterThan(0);
    expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM alerts').get()).toEqual({ n: 0 });
    expect(a.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });
});
