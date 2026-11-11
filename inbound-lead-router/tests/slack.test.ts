import { describe, expect, it } from 'vitest';
import { processLead } from '../src/lib/pipeline';
import { buildSlackMessage, escapeSlack, postToSlack, type AlertInput } from '../src/lib/slack';
import { companyFixture, companyHandlers, fakeApi, personFixture } from './fake-api';
import { pipelineDeps, shippedConfig } from './helpers';

async function tierALead(overrides: { name?: string; slackUserId?: string } = {}): Promise<AlertInput> {
  const config = shippedConfig();
  if (overrides.slackUserId) config.routing.teams['enterprise-na']!.members[0]!.slackUserId = overrides.slackUserId;
  const api = fakeApi(companyHandlers({ 'acme.example': companyFixture() }, [personFixture(1, 'VP Sales'), personFixture(2, 'CMO')]));
  return processLead({ email: 'demo@acme.example', name: overrides.name ?? 'Demo', source: 'website' }, config, pipelineDeps(api));
}

describe('buildSlackMessage', () => {
  it('builds a header, summary, account fields, score reasons, people and a context footer', async () => {
    const message = buildSlackMessage(await tierALead());
    expect(message.blocks.map((block) => block.type)).toEqual(['header', 'section', 'section', 'section', 'section', 'context']);
    expect(message.text).toBe('Tier A lead: demo@acme.example (Acme Cloud) -> Enterprise, North America, Jordan');

    const [, summary, account, score, people, footer] = message.blocks;
    expect(summary).toMatchObject({ type: 'section', text: { type: 'mrkdwn' } });
    expect(summary && 'text' in summary && summary.text.text).toContain('score *92.5 / 100*, routed to *Enterprise, North America*, owner *Jordan*');
    expect(account && 'fields' in account && account.fields?.map((field) => field.text.split('\n')[0])).toEqual([
      '*Company*',
      '*Industry*',
      '*Employees*',
      '*Revenue*',
      '*HQ*',
      '*Funding*',
    ]);
    expect(score && 'text' in score && score.text.text).toContain('• Company size: 25 / 25 (501-1K)');
    expect(people && 'text' in people && people.text.text).toContain('<https://www.linkedin.com/in/person-1|Person 1>, VP Sales');
    expect(footer).toMatchObject({ type: 'context' });
  });

  it('mentions the owner when a Slack member ID is configured', async () => {
    const message = buildSlackMessage(await tierALead({ slackUserId: 'U0JORDAN1' }));
    expect(JSON.stringify(message.blocks[1])).toContain('owner <@U0JORDAN1>');
  });

  it('escapes form input so it cannot ping a channel or inject links', async () => {
    const message = buildSlackMessage(await tierALead({ name: '<!channel> <https://evil.example|click>' }));
    const text = JSON.stringify(message.blocks);
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('&lt;!channel&gt;');
    expect(escapeSlack('a & b')).toBe('a &amp; b');
  });

  it('keeps every block within Slack limits, whatever the input length', async () => {
    const lead = await tierALead();
    lead.company = { ...lead.company!, name: 'x'.repeat(300), industry: 'y'.repeat(5000) };
    lead.lead = { ...lead.lead, name: 'z'.repeat(10_000), source: 's'.repeat(10_000) };
    lead.people = Array.from({ length: 40 }, (_, i) => ({ ...lead.people[0]!, name: 'n'.repeat(1000), position: `p${i}`.repeat(500) }));
    const message = buildSlackMessage(lead);
    const [header, ...rest] = message.blocks;
    expect(header && 'text' in header && header.text.text.length).toBe(150);
    for (const block of rest) {
      if (block.type === 'section') {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
        for (const field of block.fields ?? []) expect(field.text.length).toBeLessThanOrEqual(2000);
      }
    }
  });
});

describe('postToSlack', () => {
  const message = { text: 'hi', blocks: [] };

  it('reports a non-2xx reply without throwing', async () => {
    const failing = (async () => new Response('invalid_payload', { status: 400 })) as typeof fetch;
    expect(await postToSlack('https://hooks.slack.test/x', message, failing)).toEqual({
      channel: 'slack',
      delivered: false,
      status: 400,
      error: 'invalid_payload',
    });
  });

  it('reports a network error without throwing', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await postToSlack('https://hooks.slack.test/x', message, offline)).toMatchObject({ delivered: false, status: null, error: 'fetch failed' });
  });
});
