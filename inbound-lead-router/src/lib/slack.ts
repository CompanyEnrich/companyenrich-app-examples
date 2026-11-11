import { formatUsd, fundingStageLabel } from './format';
import type { AlertStep, DecisionTrace } from './trace';

// Slack Block Kit alert for a routed lead, sent to an incoming webhook.
// Everything that came from the form or the API is escaped, so a lead named
// "<!channel>" cannot ping a whole channel.

interface Text {
  type: 'plain_text' | 'mrkdwn';
  text: string;
}

export type SlackBlock =
  | { type: 'header'; text: Text }
  | { type: 'section'; text: Text; fields?: Text[] }
  | { type: 'context'; elements: Text[] }
  | { type: 'divider' };

export interface SlackMessage {
  /** Notification and screen-reader fallback. */
  text: string;
  blocks: SlackBlock[];
}

export type AlertInput = Omit<DecisionTrace, 'trace' | 'timings'> & {
  trace: Omit<DecisionTrace['trace'], 'alert'>;
  timings: Omit<DecisionTrace['timings'], 'alertMs'>;
};

// Slack limits: header 150 characters, section text 3,000, each field 2,000.
const HEADER_LIMIT = 150;
const SECTION_LIMIT = 3000;
const FIELD_LIMIT = 2000;

/** Escapes Slack control characters after shortening `text` to `max` characters. */
export function escapeSlack(text: string, max = 200): string {
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return short.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const mrkdwn = (text: string, max = SECTION_LIMIT): Text => ({ type: 'mrkdwn', text: clip(text, max) });

export function buildSlackMessage(lead: AlertInput): SlackMessage {
  const { decision, company, trace } = lead;
  const owner = trace.assignment.owner;
  const mention = owner.slackUserId ? `<@${owner.slackUserId}>` : `*${escapeSlack(owner.name)}*`;
  const companyName = company?.name ?? lead.lead.domain;
  const tierText = decision.tier ? `Tier ${decision.tier}` : 'Unscored';
  const who = `*${escapeSlack(lead.lead.email)}*${lead.lead.name ? ` (${escapeSlack(lead.lead.name)})` : ''}`;
  const via = lead.lead.source ? ` via ${escapeSlack(lead.lead.source)}` : '';
  const score = decision.score !== null ? `score *${decision.score} / ${decision.maxScore}*, ` : '';

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(`${tierText} lead: ${companyName}`, HEADER_LIMIT) } },
    {
      type: 'section',
      text: mrkdwn(
        `${who} signed up${via}.\n${score}routed to *${escapeSlack(decision.teamLabel)}*, owner ${mention}.\n_${escapeSlack(trace.routing.reason)}_`,
      ),
    },
  ];

  if (company) {
    const place = [company.city, company.state?.code ?? company.state?.name, company.country?.code].filter(Boolean).join(', ');
    const facts: [string, string | null][] = [
      ['Company', `<https://${company.domain}|${escapeSlack(companyName)}>`],
      ['Industry', company.industry && escapeSlack(company.industry)],
      ['Employees', company.employees],
      ['Revenue', company.revenue],
      ['HQ', place && escapeSlack(place)],
      ['Funding', fundingText(company.funding)],
    ];
    blocks.push({
      type: 'section',
      text: mrkdwn('*Account*'),
      fields: facts.filter(([, value]) => value).map(([label, value]) => mrkdwn(`*${label}*\n${value}`, FIELD_LIMIT)),
    });
  }

  if (trace.score) {
    const lines = trace.score.factors
      .filter((factor) => factor.weight > 0)
      .map((factor) => `• ${escapeSlack(factor.label)}: ${factor.points} / ${factor.weight} (${escapeSlack(factor.value)})`);
    blocks.push({ type: 'section', text: mrkdwn(`*Why this score*\n${lines.join('\n')}`) });
  }

  if (lead.people.length > 0) {
    const lines = lead.people.map((person) => {
      const name = escapeSlack(person.name ?? 'Unnamed');
      const linked = person.linkedinUrl ? `<${escapeSlack(person.linkedinUrl, 300)}|${name}>` : name;
      return `• ${linked}${person.position ? `, ${escapeSlack(person.position)}` : ''}`;
    });
    blocks.push({ type: 'section', text: mrkdwn(`*People to contact at ${escapeSlack(companyName)}*\n${lines.join('\n')}`) });
  }

  blocks.push({
    type: 'context',
    elements: [mrkdwn(`Trace ${lead.id} · ${lead.credits.spent} credits · ${lead.timings.totalMs} ms`)],
  });

  return {
    text: `${tierText} lead: ${lead.lead.email} (${companyName}) -> ${decision.teamLabel}, ${owner.name}`,
    blocks,
  };
}

function fundingText(funding: NonNullable<DecisionTrace['company']>['funding']): string | null {
  if (!funding?.stage) return null;
  const parts = [fundingStageLabel(funding.stage)];
  if (funding.date) parts.push(`(${funding.date.slice(0, 7)})`);
  if (funding.totalUsd) parts.push(`${formatUsd(funding.totalUsd)} total`);
  return parts.join(' ');
}

/** Posts to a Slack incoming webhook. Never throws: the outcome goes into the trace. */
export async function postToSlack(
  webhookUrl: string,
  message: SlackMessage,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<AlertStep> {
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return { channel: 'slack', delivered: true, status: response.status, error: null };
    const body = (await response.text()).slice(0, 200);
    return { channel: 'slack', delivered: false, status: response.status, error: body || response.statusText };
  } catch (error) {
    return { channel: 'slack', delivered: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}
