import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/lib/agent.js';
import {
  ACTION_APPROVE,
  ACTION_CANCEL,
  answerMessage,
  approvalMessage,
  blocksToText,
  bound,
  companiesMessage,
  companyMessage,
  countMessage,
  decisionMessage,
  escapeMrkdwn,
  helpMessage,
  LIMITS,
  peopleMessage,
  planMessage,
  sanitizeModelText,
  type Block,
} from '../src/lib/blocks.js';
import { companyRow, personRow } from '../src/lib/rows.js';
import { LIMITS as BUDGET, company, person } from './fixtures.js';

/** Every text in a message must fit its Block Kit limit, or Slack rejects the message. */
function expectWithinLimits(blocks: Block[]): void {
  expect(blocks.length).toBeLessThanOrEqual(50);
  for (const block of blocks) {
    if (block.type === 'header') expect(block.text.text.length).toBeLessThanOrEqual(LIMITS.header);
    if (block.type === 'section') {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(LIMITS.section);
      for (const field of block.fields ?? []) expect(field.text.length).toBeLessThanOrEqual(LIMITS.field);
    }
    if (block.type === 'markdown') expect(block.text.length).toBeLessThanOrEqual(LIMITS.markdown);
  }
}

describe('text safety', () => {
  it('escapes API text so it cannot ping a channel or fake a link', () => {
    expect(escapeMrkdwn('<!channel> AT&T <https://evil|click>')).toBe('&lt;!channel&gt; AT&amp;T &lt;https://evil|click&gt;');
  });

  it("neutralizes Slack's special syntax in Claude's text", () => {
    expect(sanitizeModelText('Hi <!here> and <@U123> **bold**')).toBe('Hi ‹!here> and ‹@U123> **bold**');
  });

  it('bounds text with an ellipsis', () => {
    expect(bound('abcdef', 4)).toBe('abc…');
    expect(bound('abc', 4)).toBe('abc');
  });
});

describe('command messages', () => {
  it('renders a company card with logo, fields and cost', () => {
    const message = companyMessage(companyRow(company('acme.example', 'Acme')), 1);
    expect(message.text).toBe('Acme (acme.example)');
    expect(message.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'Acme', emoji: true } });
    expect(message.blocks[1]).toMatchObject({ accessory: { type: 'image', image_url: 'https://logos.example/acme.example.png' } });
    const text = blocksToText(message.blocks);
    expect(text).toContain('*Funding*: series_b · $42.0M');
    expect(text).toContain('*HQ*: Berlin, Germany');
    expect(text).toContain('1 credit · CompanyEnrich');
  });

  it('keeps a company card within Block Kit limits for hostile input', () => {
    const huge = 'N'.repeat(500);
    const row = { ...companyRow(company('acme.example', huge)), description: '<'.repeat(4000), industry: '&'.repeat(3000) };
    expectWithinLimits(companyMessage(row, 1).blocks);
  });

  it('shows a count with the API interpretation and the plan-limit total', () => {
    const message = countMessage({ target: 'companies', query: 'fintech in Berlin', count: 100_000, total: 154_321, filters: ['city: 37140'], boosts: ['categories: b2b'] });
    const text = blocksToText(message.blocks);
    expect(text).toContain('*100,000* companies match _fintech in Berlin_ (154,321 before plan limits).');
    expect(text).toContain('• city: 37140');
    expect(text).toContain('Ranked higher, not filtered: categories: b2b');
  });

  it('puts the pending id, never the arguments, on the approval buttons', () => {
    const message = approvalMessage({ summary: 'Fetch 5?', details: ['seniority: vp'], estimate: 10, pendingId: 'abc-123' });
    const actions = message.blocks.find((block) => block.type === 'actions');
    expect(actions).toMatchObject({
      elements: [
        { action_id: ACTION_APPROVE, value: 'abc-123', style: 'primary', text: { text: 'Approve 10 credits' } },
        { action_id: ACTION_CANCEL, value: 'abc-123' },
      ],
    });
  });

  it('replaces a prompt with the decision and no buttons', () => {
    const message = decisionMessage('Fetch 5?', 'approved', 'U1');
    expect(message.blocks.some((block) => block.type === 'actions')).toBe(false);
    expect(message.text).toContain('Approved by <@U1>');
  });

  it('shows at most 10 rows and says how many there are', () => {
    const rows = Array.from({ length: 12 }, (_, i) => personRow(person(i + 1, 'VP Sales')));
    const message = peopleMessage('People at acme.example', rows, 24, true);
    expect(message.blocks.filter((block) => block.type === 'section')).toHaveLength(11);
    expect(blocksToText(message.blocks)).toContain('24 credits spent · CompanyEnrich. Showing 10 of 12; the full list is in the CSV below.');
  });

  it('shows lookalike similarity scores', () => {
    const message = companiesMessage('Similar', [companyRow(company('a.example', 'A'), 0.876)], 5, false);
    expect(blocksToText(message.blocks)).toContain('similarity 0.88');
  });
});

describe('agent messages', () => {
  const plan: Plan = {
    note: 'I will fetch 10 sales leaders. <!channel>',
    steps: [{ tool: 'search_people', args: { seniority: ['vp'], pageSize: 10 }, estimate: 20 }],
    estimate: 20,
    questionSpent: 0,
    status: 'needs-approval',
  };

  it('shows the plan, the estimate and buttons when approval is needed', () => {
    const message = planMessage(plan, 'pending-1');
    const text = blocksToText(message.blocks);
    expect(text).toContain('I will fetch 10 sales leaders. ‹!channel>');
    expect(text).toContain('`search_people` seniority: vp; pageSize: 10  → up to *20 credits*');
    expect(text).toContain('[Approve 20 credits] [Cancel]');
  });

  it('shows no buttons for auto-approved or blocked plans', () => {
    expect(planMessage({ ...plan, status: 'auto', estimate: 4 }).blocks.some((block) => block.type === 'actions')).toBe(false);
    const blocked = planMessage({ ...plan, status: 'blocked', blockedReason: 'over the cap' });
    expect(blocksToText(blocked.blocks)).toContain(':no_entry: Not running: over the cap.');
  });

  it('renders the answer as markdown with rows and the credits spent', () => {
    const rows = { companies: [companyRow(company('a.example', 'A'))], people: [personRow(person(1, 'CTO'))] };
    const message = answerMessage({ text: '**Two** results.', rows, spent: 3, csvFiles: 0 });
    expect(message.blocks[0]).toEqual({ type: 'markdown', text: '**Two** results.' });
    const text = blocksToText(message.blocks);
    expect(text).toContain('*Companies (1)*');
    expect(text).toContain('*People (1)*');
    expect(text).toContain('3 credits spent on this question');
    expectWithinLimits(answerMessage({ text: 'x'.repeat(20_000), rows, spent: 0, csvFiles: 1 }).blocks);
  });

  it('uses the budget limits in help', () => {
    expect(blocksToText(helpMessage(BUDGET, []).blocks)).toContain('Caps: 50 credits per question, 200 credits per person per day, 1000 credits per day for everyone.');
  });
});
