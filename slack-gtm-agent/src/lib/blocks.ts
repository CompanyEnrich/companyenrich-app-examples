import type { types } from '@slack/bolt';
import type { Plan } from './agent.js';
import type { Decision } from './approvals.js';
import type { Limits } from './budget.js';
import type { CompanyRow, PersonRow, Rows } from './rows.js';

export type Block = types.KnownBlock;

/** A Slack message: Block Kit plus the plain `text` Slack uses for notifications. */
export interface SlackMessage {
  text: string;
  blocks: Block[];
}

export const ACTION_APPROVE = 'ce_approve';
export const ACTION_CANCEL = 'ce_cancel';
/** Rows shown inline. Longer results are attached as a CSV file. */
export const MAX_INLINE_ROWS = 10;

/** Block Kit limits, in characters. Slack rejects a whole message if one block is over. */
export const LIMITS = { header: 150, section: 3000, field: 2000, context: 3000, markdown: 11_000 } as const;

/** Cut text to a Block Kit limit, marking the cut. */
export function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Escape text from the API for mrkdwn, so a description cannot contain `<!channel>` or links. */
export function escapeMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Claude's text goes into `markdown` blocks; neutralize Slack's special `<!here>` and `<@user>` syntax. */
export function sanitizeModelText(value: string): string {
  return value.replace(/<([!@#])/g, '‹$1');
}

function section(text: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text: bound(text, LIMITS.section) } };
}

function context(text: string): Block {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: bound(text, LIMITS.context) }] };
}

function header(text: string): Block {
  return { type: 'header', text: { type: 'plain_text', text: bound(text, LIMITS.header), emoji: true } };
}

function markdown(text: string): Block {
  return { type: 'markdown', text: bound(sanitizeModelText(text), LIMITS.markdown) };
}

function credits(n: number): string {
  return `${n} credit${n === 1 ? '' : 's'}`;
}

function link(url: string | undefined, label: string): string {
  return url ? `<${url}|${escapeMrkdwn(label)}>` : escapeMrkdwn(label);
}

function formatUsd(amount: number | undefined): string | undefined {
  if (amount === undefined) return undefined;
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(1)}B`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `$${(amount / 1e3).toFixed(0)}K`;
  return `$${amount}`;
}

function joinDefined(parts: Array<string | undefined>, separator = ' · '): string {
  return parts.filter((part): part is string => Boolean(part)).join(separator);
}

// ----- Command mode -----

export function helpMessage(limits: Limits, pricing: Array<{ tool: string; pricing: string }>): SlackMessage {
  const lines = [
    '*`/ce company <domain>`*  Company profile. 1 credit.',
    '*`/ce count <plain English>`*  Free company count, with how the API read your words. `/ce count people <plain English>` counts people.',
    '*`/ce people <domain> <role words> [n]`*  Free count, then fetch up to n people (default 5) after you click Approve. 2 credits per person.',
    '*`/ce lookalikes <domain> [n]`*  Free count, then fetch n similar companies (default 5) after you click Approve. 5 credits per company.',
    '*`/ce balance`*  Account credits and what you spent through this bot today. Free.',
    'Or mention me with a question, for example "@companyenrich VPs of sales at Series B fintechs in Berlin?" (needs ANTHROPIC_API_KEY).',
  ];
  const caps = `Agent steps above ${credits(limits.approvalThreshold)} wait for Approve. Caps: ${credits(limits.questionCap)} per question, ${credits(limits.dailyUserCap)} per person per day, ${credits(limits.dailyTotalCap)} per day for everyone.`;
  const toolPricing = pricing.map((entry) => `\`${entry.tool}\`: ${entry.pricing}`).join('\n');
  return {
    text: 'CompanyEnrich commands',
    blocks: [header('CompanyEnrich in Slack'), section(lines.join('\n')), context(caps), context(`Tool pricing enforced by this bot:\n${toolPricing}`)],
  };
}

export function companyMessage(company: CompanyRow, spent: number): SlackMessage {
  const name = company.name ?? company.domain ?? 'Company';
  const hq = joinDefined([company.city, company.country], ', ');
  const fields = [
    ['Domain', company.domain],
    ['Industry', company.industry],
    ['Employees', company.employees],
    ['Revenue', company.revenue],
    ['Founded', company.foundedYear?.toString()],
    ['HQ', hq || undefined],
    ['Type', company.type],
    ['Funding', joinDefined([company.fundingStage, formatUsd(company.totalFunding)]) || undefined],
  ].filter((field): field is [string, string] => Boolean(field[1]));

  const intro: Block = {
    type: 'section',
    text: { type: 'mrkdwn', text: bound(escapeMrkdwn(company.description ?? 'No description on record.'), LIMITS.section) },
    ...(company.logoUrl ? { accessory: { type: 'image', image_url: company.logoUrl, alt_text: `${name} logo` } } : {}),
  };
  return {
    text: `${name} (${company.domain ?? 'unknown domain'})`,
    blocks: [
      header(name),
      intro,
      {
        type: 'section',
        fields: fields.map(([label, value]) => ({ type: 'mrkdwn', text: bound(`*${label}*\n${escapeMrkdwn(value)}`, LIMITS.field) })),
      },
      context(joinDefined([company.linkedinUrl ? link(company.linkedinUrl, 'LinkedIn') : undefined, `${credits(spent)} · CompanyEnrich`])),
    ],
  };
}

export function countMessage(input: {
  target: 'companies' | 'people';
  query: string;
  count: number;
  total: number;
  filters: string[];
  boosts: string[];
}): SlackMessage {
  const { target, query, count, total, filters, boosts } = input;
  const totalNote = total > count ? ` (${total.toLocaleString('en-US')} before plan limits)` : '';
  const lines = [`*${count.toLocaleString('en-US')}* ${target} match _${escapeMrkdwn(query)}_${totalNote}.`];
  lines.push(
    filters.length
      ? `The API read this as:\n${filters.map((filter) => `• ${escapeMrkdwn(filter)}`).join('\n')}`
      : 'The API did not infer any filters, so this counts by meaning alone.',
  );
  if (boosts.length) lines.push(`Ranked higher, not filtered: ${escapeMrkdwn(boosts.join('; '))}`);
  const note =
    target === 'companies'
      ? 'Free count. A semantic count is the size of the candidate pool the search ranks, so treat large numbers as an upper bound. City and state values are CompanyEnrich ids.'
      : 'Free count.';
  return { text: `${count} ${target} match "${query}"`, blocks: [section(lines.join('\n')), context(note)] };
}

export function approvalMessage(input: { summary: string; details: string[]; estimate: number; pendingId: string }): SlackMessage {
  const { summary, details, estimate, pendingId } = input;
  return {
    text: `Approve ${credits(estimate)}? ${summary}`,
    blocks: [
      section(`${summary}\n${details.map((line) => `• ${line}`).join('\n')}`),
      context(`Estimated cost: up to *${credits(estimate)}*. Nothing is charged until you approve. This request expires in 15 minutes.`),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: ACTION_APPROVE,
            style: 'primary',
            text: { type: 'plain_text', text: `Approve ${credits(estimate)}` },
            value: pendingId,
          },
          { type: 'button', action_id: ACTION_CANCEL, text: { type: 'plain_text', text: 'Cancel' }, value: pendingId },
        ],
      },
    ],
  };
}

export function decisionMessage(summary: string, decision: Decision, userId: string): SlackMessage {
  const outcome = {
    approved: `:white_check_mark: Approved by <@${userId}>. Fetching now.`,
    cancelled: `:x: Cancelled by <@${userId}>. Nothing was charged.`,
    expired: ':hourglass: This request expired. Nothing was charged. Run the command again.',
  }[decision];
  return { text: outcome, blocks: [section(summary), context(outcome)] };
}

export function companiesMessage(title: string, rows: CompanyRow[], spent: number, csvAttached: boolean): SlackMessage {
  return {
    text: title,
    blocks: [
      section(`*${escapeMrkdwn(title)}*`),
      ...rows.slice(0, MAX_INLINE_ROWS).map((row) => section(companyLine(row))),
      context(resultFooter(rows.length, spent, csvAttached)),
    ],
  };
}

export function peopleMessage(title: string, rows: PersonRow[], spent: number, csvAttached: boolean): SlackMessage {
  return {
    text: title,
    blocks: [
      section(`*${escapeMrkdwn(title)}*`),
      ...rows.slice(0, MAX_INLINE_ROWS).map((row) => section(personLine(row))),
      context(resultFooter(rows.length, spent, csvAttached)),
    ],
  };
}

function companyLine(row: CompanyRow): string {
  const name = link(row.domain ? `https://${row.domain}` : undefined, row.name ?? row.domain ?? 'Unknown');
  const where = joinDefined([row.city, row.country], ', ');
  const facts = joinDefined([row.industry, row.employees && `${row.employees} employees`, where || undefined]);
  const score = row.score === undefined ? '' : ` · similarity ${row.score.toFixed(2)}`;
  return `*${name}* (${escapeMrkdwn(row.domain ?? 'no domain')})\n${escapeMrkdwn(facts)}${score}`;
}

function personLine(row: PersonRow): string {
  const name = link(row.linkedinUrl, row.name ?? 'Unnamed');
  const role = joinDefined([row.position, row.company]);
  const facts = joinDefined([row.seniority, row.department, row.country]);
  return `*${name}*  ${escapeMrkdwn(role)}\n${escapeMrkdwn(facts)}`;
}

function resultFooter(count: number, spent: number, csvAttached: boolean): string {
  const more = count > MAX_INLINE_ROWS ? ` Showing ${MAX_INLINE_ROWS} of ${count}${csvAttached ? '; the full list is in the CSV below' : ''}.` : '';
  return `${credits(spent)} spent · CompanyEnrich.${more}`;
}

export function balanceMessage(input: {
  used: number;
  total: number;
  spentToday: number;
  limits: Limits;
}): SlackMessage {
  const { used, total, spentToday, limits } = input;
  const remaining = Math.max(0, total - used);
  return {
    text: `${remaining} CompanyEnrich credits left`,
    blocks: [
      section(
        `*${remaining.toLocaleString('en-US')}* of ${total.toLocaleString('en-US')} CompanyEnrich credits left on the account.\n` +
          `You spent *${credits(spentToday)}* through this bot today (your daily cap is ${limits.dailyUserCap}).`,
      ),
      context(`Approval above ${credits(limits.approvalThreshold)} per agent step · cap ${credits(limits.questionCap)} per question. Free check.`),
    ],
  };
}

export function noticeMessage(text: string): SlackMessage {
  return { text, blocks: [section(text)] };
}

export function errorMessage(text: string): SlackMessage {
  return { text, blocks: [section(`:warning: ${text}`)] };
}

// ----- Agent mode -----

/** Arguments as one short line, for showing a planned tool call. */
export function describeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => {
    const shown = Array.isArray(value) ? value.join(', ') : typeof value === 'object' && value ? JSON.stringify(value) : String(value);
    return `${key}: ${shown}`;
  });
  const line = parts.join('; ');
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}

export function planMessage(plan: Plan, pendingId?: string): SlackMessage {
  const steps = plan.steps
    .map((step) => `• \`${step.tool}\` ${escapeMrkdwn(describeArgs(step.args))}  → up to *${credits(step.estimate)}*`)
    .join('\n');
  const status = {
    auto: `Running now: ${credits(plan.estimate)} is within the auto-approve threshold.`,
    'needs-approval': `Estimated up to *${credits(plan.estimate)}*, above the auto-approve threshold. Nothing is charged until you approve.`,
    blocked: `:no_entry: Not running: ${plan.blockedReason ?? 'over budget'}.`,
  }[plan.status];
  const blocks: Block[] = [section('*Plan*')];
  if (plan.note.trim()) blocks.push(markdown(plan.note));
  blocks.push(section(steps), context(`${status} Spent on this question so far: ${credits(plan.questionSpent)}.`));
  if (plan.status === 'needs-approval' && pendingId) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: ACTION_APPROVE,
          style: 'primary',
          text: { type: 'plain_text', text: `Approve ${credits(plan.estimate)}` },
          value: pendingId,
        },
        { type: 'button', action_id: ACTION_CANCEL, text: { type: 'plain_text', text: 'Cancel' }, value: pendingId },
      ],
    });
  }
  return { text: `Plan: up to ${credits(plan.estimate)}`, blocks };
}

export function answerMessage(input: { text: string; rows: Rows; spent: number; csvFiles: number }): SlackMessage {
  const { text, rows, spent, csvFiles } = input;
  const blocks: Block[] = [markdown(text || 'I could not find an answer.')];
  if (rows.companies.length) {
    blocks.push({ type: 'divider' }, section(`*Companies (${rows.companies.length})*`));
    blocks.push(...rows.companies.slice(0, MAX_INLINE_ROWS).map((row) => section(companyLine(row))));
  }
  if (rows.people.length) {
    blocks.push({ type: 'divider' }, section(`*People (${rows.people.length})*`));
    blocks.push(...rows.people.slice(0, MAX_INLINE_ROWS).map((row) => section(personLine(row))));
  }
  const csvNote = csvFiles ? ` Full results are in the attached CSV${csvFiles > 1 ? ' files' : ''}.` : '';
  blocks.push(context(`${credits(spent)} spent on this question · CompanyEnrich data, answer by Claude.${csvNote}`));
  return { text: text.slice(0, 300) || 'Answer', blocks };
}

// ----- Plain-text rendering (simulator output, README examples) -----

/** A readable plain-text rendering of Block Kit, roughly what a Slack user sees. */
export function blocksToText(blocks: Block[]): string {
  const unescape = (value: string) =>
    value
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'header':
        lines.push(`# ${block.text.text}`);
        break;
      case 'section':
        if (block.text) lines.push(unescape(block.text.text));
        for (const field of block.fields ?? []) lines.push(unescape(field.text).replace('\n', ': '));
        break;
      case 'markdown':
        lines.push(block.text);
        break;
      case 'context':
        for (const element of block.elements) {
          if ('text' in element && typeof element.text === 'string') lines.push(`  ${unescape(element.text)}`);
        }
        break;
      case 'actions':
        lines.push(
          block.elements
            .map((element) => ('text' in element && element.text && 'text' in element.text ? `[${element.text.text}]` : ''))
            .join(' '),
        );
        break;
      case 'divider':
        lines.push('---');
        break;
    }
  }
  return lines.join('\n');
}
