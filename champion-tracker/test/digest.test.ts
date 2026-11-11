import { describe, expect, it } from 'vitest';
import type { ChampionAlert, CheckReport } from '../src/lib/check.js';
import { type Alert, detectChange } from '../src/lib/detect.js';
import { renderDigest } from '../src/lib/digest.js';
import { buildSlackPayload, postToSlack } from '../src/lib/slack.js';
import { baseline, company, person, role } from './helpers/fixtures.js';

const LAST_CHECK = '2026-10-01T08:00:00.000Z';

function alertFor(change: ReturnType<typeof detectChange>, overrides: Partial<ChampionAlert> = {}): ChampionAlert {
  return {
    owner: 'alex@yourco.example',
    dealName: 'Acme rollout',
    accountDomain: 'acme.example',
    name: 'Jane Champion',
    linkedinUrl: 'https://www.linkedin.com/in/jane-champion-example',
    profileUpdatedAt: '2026-10-20T00:00:00Z',
    change: change as Alert,
    research: null,
    ...overrides,
  };
}

const move = alertFor(
  detectChange(baseline(), person([role('globex.example', { position: 'VP Sales', seniority: 'vp', start: '2026-09-01' }), role('acme.example', { end: '2026-08-01' })]), LAST_CHECK),
  {
    research: {
      company: company('globex.example'),
      icp: { score: 80, fit: 'strong', parts: [{ criterion: 'employees', value: '201-500', points: 40, max: 40, verdict: 'match' }, { criterion: 'country', value: 'DE', points: 0, max: 10, verdict: 'miss' }] },
      persona: { total: 14, accessible: 14 },
      contacts: [],
      notes: [],
    },
  },
);
const promotion = alertFor(detectChange(baseline(), person([role('acme.example', { position: 'VP Sales', seniority: 'vp', start: '2026-09-01' })]), LAST_CHECK), {
  owner: 'U0123ABCDEF',
  name: 'Sam <Example> & Co',
});
const departure = alertFor(detectChange(baseline(), person([role('acme.example', { end: '2026-09-01' })]), LAST_CHECK), { name: 'Lee Example' });

function report(alerts: ChampionAlert[], overrides: Partial<CheckReport> = {}): CheckReport {
  return {
    date: '2026-11-11',
    tracked: 10,
    due: 4,
    checked: 4,
    unchanged: 4 - alerts.length,
    deferred: 0,
    alerts,
    problems: [],
    spent: 9,
    cap: 40,
    breakdown: 'people.get x4 = 8, companies.enrich x1 = 1',
    ...overrides,
  };
}

describe('renderDigest', () => {
  it('groups alerts by owner with moves, then promotions, then departures', () => {
    const digest = renderDigest(report([departure, promotion, move]));
    expect(digest).toMatch(/^# Champion digest, 2026-11-11\n\nChecked 4 of 4 due champions \(10 tracked\): 1 moved, 1 promoted, 1 left, 1 unchanged\. Spent 9 credits\./);
    const order = ['## Owner: alex@yourco.example', '### Moved: Jane Champion is now at Globex', '### Left, destination unknown: Lee Example', '## Owner: U0123ABCDEF'].map((text) =>
      digest.indexOf(text),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows the move details: before, now, ICP fit and buyer persona count', () => {
    const digest = renderDigest(report([move]));
    expect(digest).toContain('- Before: Director of Sales at Acme, since 2023-04');
    expect(digest).toContain('- Now: VP Sales at Globex (globex.example), since 2026-09');
    expect(digest).toContain('- ICP fit: 80/100, strong (employees 201-500: match; country DE: miss)');
    expect(digest).toContain('- Buyer persona there: 14 other people match');
  });

  it('shows the full persona population and labels a plan-capped count', () => {
    const capped = { ...move, research: { ...move.research!, persona: { total: 12345, accessible: 10 } } };
    expect(renderDigest(report([capped]))).toContain('- Buyer persona there: 12,345 other people match (10 accessible on your plan)');
  });

  it('flags a likely move whose old role is still listed', () => {
    const likely = alertFor(detectChange(baseline(), person([role('acme.example'), role('globex.example', { start: '2026-09-01' })]), LAST_CHECK));
    expect(renderDigest(report([likely]))).toContain('Still listed at Acme too, so the old role may not be closed yet.');
  });

  it('lists deferred checks and problems under "Needs attention"', () => {
    const digest = renderDigest(report([], { deferred: 3, problems: [{ owner: 'alex@yourco.example', dealName: 'Acme rollout', champion: 'person 7', reason: 'profile not found' }] }));
    expect(digest).toContain('No changes: nobody moved, got promoted or left.');
    expect(digest).toContain('- alex@yourco.example, Acme rollout: person 7: profile not found');
    expect(digest).toContain('- 3 due champions were not checked because of the 40-credit cap.');
  });
});

describe('buildSlackPayload', () => {
  it('builds Block Kit with a header, a summary and one section per alert', () => {
    const payload = buildSlackPayload(report([move, promotion]), 'output/digest-2026-11-11.md');
    expect(payload.text).toMatch(/1 moved, 1 promoted/);
    expect(payload.blocks.map((block) => block.type)).toEqual(['header', 'context', 'divider', 'section', 'section', 'divider', 'section', 'section']);
    const sections = payload.blocks.flatMap((block) => (block.type === 'section' ? [block.text.text] : []));
    expect(sections[0]).toBe('*Owner: alex@yourco.example*');
    expect(sections[1]).toMatch(/^\*Moved: Jane Champion is now at Globex\*\n• Deal: Acme rollout \(acme\.example\)/);
    expect(sections[2]).toBe('*Owner: <@U0123ABCDEF>*');
    expect(sections[3]).toContain('Sam &lt;Example&gt; &amp; Co');
  });

  it('stays within Slack limits for large digests', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ ...move, owner: `owner${index}@yourco.example` }));
    const payload = buildSlackPayload(report(many), 'output/digest-2026-11-11.md');
    expect(payload.blocks).toHaveLength(50);
    expect(payload.blocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Truncated for Slack. The full digest is in output/digest-2026-11-11.md.' }] });
    for (const block of payload.blocks) if (block.type === 'section') expect(block.text.text.length).toBeLessThanOrEqual(3000);
  });
});

describe('postToSlack', () => {
  it('posts JSON and reports a non-200 answer', async () => {
    const seen: RequestInit[] = [];
    const ok: typeof fetch = async (_url, init) => (seen.push(init!), new Response('ok'));
    await postToSlack('https://hooks.slack.example/x', { text: 'hi', blocks: [] }, ok);
    expect(seen[0]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hi","blocks":[]}' });

    const failing: typeof fetch = async () => new Response('invalid_blocks', { status: 400 });
    await expect(postToSlack('https://hooks.slack.example/x', { text: 'hi', blocks: [] }, failing)).rejects.toThrow('Slack returned 400: invalid_blocks');
  });
});
