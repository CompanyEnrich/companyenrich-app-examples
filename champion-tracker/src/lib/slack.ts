import type { CheckReport } from './check.js';
import { attentionItems, facts, groupByOwner, headline, summarize } from './digest.js';

type TextObject = { type: 'plain_text' | 'mrkdwn'; text: string };
export type SlackBlock =
  | { type: 'header'; text: TextObject }
  | { type: 'section'; text: TextObject }
  | { type: 'context'; elements: TextObject[] }
  | { type: 'divider' };

export interface SlackPayload {
  /** Shown in notifications and by clients that cannot render blocks. */
  text: string;
  blocks: SlackBlock[];
}

// Slack rejects messages with more than 50 blocks or section text over 3,000 characters.
const MAX_BLOCKS = 50;
const MAX_SECTION_TEXT = 3000;

export function buildSlackPayload(report: CheckReport, digestPath: string): SlackPayload {
  const head: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: `Champion digest, ${report.date}` } },
    { type: 'context', elements: [mrkdwn(escape(summarize(report)))] },
  ];

  const body: SlackBlock[] = [];
  for (const [owner, alerts] of groupByOwner(report.alerts)) {
    body.push({ type: 'divider' }, section(`*Owner: ${ownerLabel(owner)}*`));
    for (const alert of alerts) {
      body.push(section(`*${escape(headline(alert))}*\n${facts(alert).map((fact) => `• ${escape(fact)}`).join('\n')}`));
    }
  }
  const attention = attentionItems(report);
  if (attention.length > 0) {
    body.push({ type: 'divider' }, section(`*Needs attention*\n${attention.map((item) => `• ${escape(item)}`).join('\n')}`));
  }

  const room = MAX_BLOCKS - head.length - 1;
  if (body.length <= room) return { text: summarize(report), blocks: [...head, ...body] };
  return {
    text: summarize(report),
    blocks: [...head, ...body.slice(0, room), { type: 'context', elements: [mrkdwn(`Truncated for Slack. The full digest is in ${escape(digestPath)}.`)] }],
  };
}

export async function postToSlack(webhookUrl: string, payload: SlackPayload, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Slack returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

/** An owner given as a Slack member id (U…) is mentioned so they get notified. */
function ownerLabel(owner: string): string {
  return /^[UW][A-Z0-9]{8,}$/.test(owner) ? `<@${owner}>` : escape(owner);
}

function section(text: string): SlackBlock {
  const fitted = text.length > MAX_SECTION_TEXT ? `${text.slice(0, MAX_SECTION_TEXT - 1)}…` : text;
  return { type: 'section', text: mrkdwn(fitted) };
}

function mrkdwn(text: string): TextObject {
  return { type: 'mrkdwn', text };
}

/** Slack treats &, < and > as control characters in message text. */
function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
