import { describe, expect, it } from 'vitest';
import type { Digest, Signal } from '../src/lib/digest.js';
import { buildSlackPayload, postToSlack } from '../src/lib/slack.js';

const signal = (index: number): Signal => ({
  title: `Company ${index}`,
  domain: `co${index}.com`,
  summary: 'Series A on 2026-03-02 · $12M raised in total',
  details: [],
  link: { label: `co${index}.com`, url: `https://co${index}.com` },
});

const digest: Digest = {
  date: '2026-11-11',
  creditsCharged: 9,
  maxCredits: 50,
  reports: [
    { id: 'funded', type: 'new-companies', title: 'Funded <SaaS> & co', signals: [signal(1)], notes: ['2 more matches will be picked up on later runs.'], creditsCharged: 1 },
    {
      id: 'accounts',
      type: 'account-changes',
      title: 'Account changes',
      signals: [{ ...signal(2), summary: '1 change since 2026-11-04', details: ['Employees: 201-500 → 501-1K'] }],
      notes: [],
      creditsCharged: 8,
    },
    { id: 'leaders', type: 'new-leaders', title: 'New leaders', signals: [], notes: [], creditsCharged: 0, error: 'CompanyEnrich returned 402' },
  ],
};

describe('buildSlackPayload', () => {
  it('builds a header, a summary and one section per watcher', () => {
    const payload = buildSlackPayload(digest);
    expect(payload.text).toBe('2 new signals from 3 watchers. Credits used: 9 (cap 50).');
    expect(payload.blocks.map((block) => block.type)).toEqual([
      'header', 'context', 'divider', 'section', 'context', 'divider', 'section', 'divider', 'section', 'context',
    ]);
    expect(payload.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'GTM signals: 2026-11-11' } });
    expect(payload.blocks[3]).toEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Funded &lt;SaaS&gt; &amp; co*\n• *Company 1*: Series A on 2026-03-02 · $12M raised in total <https://co1.com|co1.com>',
      },
    });
    expect(payload.blocks[6]).toMatchObject({ text: { text: expect.stringContaining('\n    ◦ Employees: 201-500 → 501-1K') } });
    expect(payload.blocks[8]).toMatchObject({ text: { text: '*New leaders*\n_No new signals._' } });
    expect(payload.blocks[9]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Error: CompanyEnrich returned 402' }] });
  });

  it('keeps each section under the 3,000 character limit', () => {
    const big: Digest = {
      ...digest,
      reports: [{ id: 'funded', type: 'new-companies', title: 'Funded', signals: Array.from({ length: 100 }, (_, i) => signal(i)), notes: [], creditsCharged: 0 }],
    };
    const section = buildSlackPayload(big).blocks.find((block) => block.type === 'section');
    const text = section?.type === 'section' ? section.text.text : '';
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toMatch(/…and \d+ more in the Markdown digest\.$/);
  });
});

describe('buildSlackPayload limits', () => {
  it('bounds user-controlled titles in every block, without cutting an escape in half', () => {
    const longTitle = '&'.repeat(3100);
    const payload = buildSlackPayload({
      ...digest,
      reports: [
        { id: 'a', type: 'new-companies', title: longTitle, signals: [], notes: [], creditsCharged: 0 },
        { id: 'b', type: 'new-companies', title: longTitle, signals: [signal(1)], notes: ['x'.repeat(5000)], creditsCharged: 0 },
      ],
    });

    for (const block of payload.blocks) {
      if (block.type === 'header') expect(block.text.text.length).toBeLessThanOrEqual(150);
      if (block.type === 'section') {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
        expect(block.text.text).not.toMatch(/&a?m?p?…/);
      }
      if (block.type === 'context') expect(block.elements[0]!.text.length).toBeLessThanOrEqual(2000);
    }
    const section = payload.blocks.find((block) => block.type === 'section');
    expect(section?.type === 'section' && section.text.text.startsWith('*&amp;&amp;')).toBe(true);
  });
});

describe('postToSlack', () => {
  it('posts the payload as JSON to the webhook', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response('ok');
    };
    const payload = buildSlackPayload(digest);
    await postToSlack('https://hooks.slack.test/T000/B000/XXX', payload, fakeFetch);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://hooks.slack.test/T000/B000/XXX');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(payload);
  });

  it('throws with the status when Slack rejects the post', async () => {
    const fakeFetch: typeof fetch = async () => new Response('invalid_blocks', { status: 400 });
    await expect(postToSlack('https://hooks.slack.test/x', buildSlackPayload(digest), fakeFetch)).rejects.toThrow(
      'Slack webhook returned 400: invalid_blocks',
    );
  });
});
