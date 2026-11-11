import { type Digest, type WatcherReport, summaryLine } from './digest.js';

type TextObject = { type: 'plain_text' | 'mrkdwn'; text: string };
export type SlackBlock =
  | { type: 'header'; text: TextObject }
  | { type: 'section'; text: TextObject }
  | { type: 'context'; elements: TextObject[] }
  | { type: 'divider' };

export interface SlackPayload {
  /** Fallback for notifications and clients that cannot show blocks. */
  text: string;
  blocks: SlackBlock[];
}

// Block Kit limits: 50 blocks per message, 3,000 characters per section, 150 per header.
const MAX_BLOCKS = 50;
const MAX_HEADER_CHARS = 150;
const MAX_SECTION_CHARS = 3000;
const MAX_CONTEXT_CHARS = 2000;
/** Watcher titles come from the config, so keep a long one from crowding out the signals. */
const MAX_HEADING_CHARS = 200;

export function buildSlackPayload(digest: Digest): SlackPayload {
  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(`GTM signals: ${digest.date}`, MAX_HEADER_CHARS) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: clip(escape(summaryLine(digest)), MAX_CONTEXT_CHARS) }] },
  ];

  for (const report of digest.reports) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: sectionText(report) } });
    const notes = [...(report.error ? [`Error: ${report.error}`] : []), ...report.notes];
    if (notes.length > 0) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(notes.map(escape).join('\n'), MAX_CONTEXT_CHARS) }] });
    }
  }

  if (blocks.length > MAX_BLOCKS) {
    blocks.length = MAX_BLOCKS - 1;
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Too many watchers for one message; see the Markdown digest for the rest.' }],
    });
  }

  return { text: summaryLine(digest), blocks };
}

export async function postToSlack(webhookUrl: string, payload: SlackPayload, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

function sectionText(report: WatcherReport): string {
  const heading = `*${clip(escape(report.title), MAX_HEADING_CHARS)}*`;
  if (report.signals.length === 0) return `${heading}\n_No new signals._`;

  let text = heading;
  for (const [index, signal] of report.signals.entries()) {
    const details = signal.details.map((detail) => `\n    ◦ ${escape(detail)}`).join('');
    const line = `\n• *${escape(signal.title)}*: ${escape(signal.summary)} <${signal.link.url}|${escape(signal.link.label)}>${details}`;
    const overflow = `\n…and ${report.signals.length - index} more in the Markdown digest.`;
    if (text.length + line.length + overflow.length > MAX_SECTION_CHARS) return clip(text + overflow, MAX_SECTION_CHARS);
    text += line;
  }
  return text;
}

/** Slack mrkdwn treats &, < and > as control characters. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Shortens text to `max` characters without cutting an escape such as `&amp;` in half. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/&[a-z]*$/, '')}…`;
}
