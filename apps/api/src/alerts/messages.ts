import {
  ALERT_RULE_LABELS,
  SEVERITY_LABELS,
  describeAffected,
  type AlertAffected,
  type AlertRuleType,
  type NotificationEvent,
  type Severity,
} from '@qa/shared';

/**
 * Slack·이메일 메시지 (TRD §9.4). 발송 큐 한 줄(또는 요약으로 묶은 여러 줄)을 사람이 읽을 글로 바꾼다.
 * 대상 DB나 메타 저장소를 읽지 않는 순수 함수다.
 */

export interface OutboundItem {
  event: NotificationEvent;
  alert: { id: number; type: AlertRuleType; severity: Severity; affected: AlertAffected | null };
  scheduler: { id: number; displayName: string };
  envLabel: string | null;
}

export const EVENT_LABELS: Record<NotificationEvent, string> = {
  fire: '발생',
  update: '대상 늘어남',
  reminder: '계속됨',
  resolve: '해소',
};

/** 대상 상위 몇 개를 적는지 */
export const LISTED_TARGETS = 10;

/** 심각도 색. 해소는 초록 */
const COLORS: Record<Severity | 'resolved', string> = {
  info: '#2e90fa',
  warning: '#f79009',
  critical: '#d92d20',
  resolved: '#12b76a',
};

const colorOf = (item: OutboundItem) =>
  item.event === 'resolve' ? COLORS.resolved : COLORS[item.alert.severity];

/** `[심각] 정산 배치 · ERROR 트리거 발생` */
export function titleOf(item: OutboundItem): string {
  return `[${SEVERITY_LABELS[item.alert.severity]}] ${item.scheduler.displayName} · ${
    ALERT_RULE_LABELS[item.alert.type]
  } ${EVENT_LABELS[item.event]}`;
}

/** 대상 상위 {@link LISTED_TARGETS}개를 한 줄씩 */
export function targetLines(affected: AlertAffected | null): string[] {
  if (!affected) return [];
  switch (affected.kind) {
    case 'triggers': {
      const lines = affected.triggers.slice(0, LISTED_TARGETS).map((t) => `${t.group}.${t.name}`);
      const rest = affected.total - lines.length;
      return rest > 0 ? [...lines, `외 ${rest}개`] : lines;
    }
    case 'nodes':
      return affected.nodes
        .slice(0, LISTED_TARGETS)
        .map((n) => `${n.instanceName} (${n.active ? '활성' : '체크인 지연'})`);
    case 'monitor':
      return affected.errorMessage ? [affected.errorMessage] : [];
  }
}

export function alertLink(publicUrl: string, item: OutboundItem): string {
  return `${publicUrl}/scheduler?id=${item.scheduler.id}&tab=alerts`;
}

export function summaryTitle(items: OutboundItem[]): string {
  return `quartz-admin 알림 ${items.length}건`;
}

// ── Slack (Block Kit) ────────────────────────────────────────────

/** Slack mrkdwn에서 뜻이 있는 글자를 바꾼다 */
function mrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function slackPayload(items: OutboundItem[], publicUrl: string): unknown {
  if (items.length === 1) {
    const item = items[0]!;
    const title = titleOf(item);
    const targets = targetLines(item.alert.affected);
    return {
      text: mrkdwn(title),
      attachments: [
        {
          color: colorOf(item),
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${mrkdwn(title)}*` } },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*스케줄러*\n${mrkdwn(item.scheduler.displayName)}` },
                { type: 'mrkdwn', text: `*환경*\n${mrkdwn(item.envLabel ?? '-')}` },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*요약*\n${mrkdwn(describeAffected(item.alert.affected) || '-')}`,
              },
            },
            ...(targets.length > 0
              ? [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `*대상*\n${targets.map((t) => `• ${mrkdwn(t)}`).join('\n')}`,
                    },
                  },
                ]
              : []),
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `<${alertLink(publicUrl, item)}|도구에서 보기>` }],
            },
          ],
        },
      ],
    };
  }
  // 요약: 가장 높은 심각도의 색, 알림마다 한 줄
  const worst = items.some((i) => i.event !== 'resolve' && i.alert.severity === 'critical')
    ? COLORS.critical
    : items.some((i) => i.event !== 'resolve' && i.alert.severity === 'warning')
      ? COLORS.warning
      : COLORS.resolved;
  const title = summaryTitle(items);
  return {
    text: mrkdwn(title),
    attachments: [
      {
        color: worst,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${mrkdwn(title)}*` } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: items
                .map(
                  (i) =>
                    `• <${alertLink(publicUrl, i)}|${mrkdwn(titleOf(i))}> ${mrkdwn(
                      describeAffected(i.alert.affected),
                    )}`,
                )
                .join('\n'),
            },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `<${publicUrl}/alerts|알림 센터에서 보기>` }],
          },
        ],
      },
    ],
  };
}

// ── 이메일 ───────────────────────────────────────────────────────

function html(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export function emailContent(items: OutboundItem[], publicUrl: string): EmailContent {
  if (items.length === 1) {
    const item = items[0]!;
    const title = titleOf(item);
    const targets = targetLines(item.alert.affected);
    const link = alertLink(publicUrl, item);
    const rows: [string, string][] = [
      ['스케줄러', item.scheduler.displayName],
      ['환경', item.envLabel ?? '-'],
      ['요약', describeAffected(item.alert.affected) || '-'],
    ];
    return {
      subject: title,
      text: [
        title,
        '',
        ...rows.map(([k, v]) => `${k}: ${v}`),
        ...(targets.length > 0 ? ['', '대상:', ...targets.map((t) => `- ${t}`)] : []),
        '',
        `도구에서 보기: ${link}`,
      ].join('\n'),
      html: [
        `<div style="font-family:sans-serif;border-left:4px solid ${colorOf(item)};padding-left:12px">`,
        `<h2 style="margin:0 0 12px;font-size:16px">${html(title)}</h2>`,
        '<table style="border-collapse:collapse">',
        ...rows.map(
          ([k, v]) =>
            `<tr><th style="text-align:left;padding:2px 12px 2px 0;color:#555">${html(k)}</th><td>${html(v)}</td></tr>`,
        ),
        '</table>',
        ...(targets.length > 0
          ? [
              '<p style="margin:12px 0 4px;color:#555">대상</p><ul style="margin:0">',
              ...targets.map((t) => `<li><code>${html(t)}</code></li>`),
              '</ul>',
            ]
          : []),
        `<p style="margin-top:16px"><a href="${html(link)}">도구에서 보기</a></p>`,
        '</div>',
      ].join(''),
    };
  }
  const title = summaryTitle(items);
  const lines = items.map((i) => `${titleOf(i)} — ${describeAffected(i.alert.affected)}`);
  return {
    subject: title,
    text: [title, '', ...lines.map((l) => `- ${l}`), '', `알림 센터: ${publicUrl}/alerts`].join(
      '\n',
    ),
    html: [
      '<div style="font-family:sans-serif">',
      `<h2 style="margin:0 0 12px;font-size:16px">${html(title)}</h2><ul>`,
      ...items.map(
        (i) =>
          `<li><a href="${html(alertLink(publicUrl, i))}">${html(titleOf(i))}</a> ${html(
            describeAffected(i.alert.affected),
          )}</li>`,
      ),
      `</ul><p><a href="${html(`${publicUrl}/alerts`)}">알림 센터에서 보기</a></p></div>`,
    ].join(''),
  };
}
