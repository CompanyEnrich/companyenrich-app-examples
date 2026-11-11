import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { LogLevel, verifySlackRequest } from '@slack/bolt';
import { afterEach, describe, expect, it } from 'vitest';
import { MockSlack, type SlackTraffic } from '../src/dev/mock-slack.js';
import { appMentionBody, buttonClickBody, postSigned, signSlackRequest, slashCommandBody } from '../src/dev/signing.js';
import { GtmAgent } from '../src/lib/agent.js';
import { Approvals } from '../src/lib/approvals.js';
import { ACTION_APPROVE, blocksToText, type Block } from '../src/lib/blocks.js';
import type { Toolbox } from '../src/lib/toolbox.js';
import { createSlackApp, isFreshTimestamp } from '../src/slack/app.js';
import { scriptedClaude, text, toolUse } from './claude-mock.js';
import { fakeCountTools, makeToolbox, type FakeMcp } from './fixtures.js';

const SECRET = 'test-signing-secret';
const FORM = 'application/x-www-form-urlencoded';

interface Harness {
  slack: MockSlack;
  url: string;
  mcp: FakeMcp;
  toolbox: Toolbox;
  idle: () => Promise<void>;
  command: (text: string, userId?: string) => Promise<Response>;
  click: (traffic: SlackTraffic, userId?: string) => Promise<Response>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startHarness(options: { agent?: (toolbox: Toolbox) => GtmAgent; people?: number } = {}): Promise<Harness> {
  const slack = new MockSlack();
  await slack.start();
  const { toolbox, mcp } = await makeToolbox({ localTools: fakeCountTools({ people: options.people ?? 2 }) });
  const agent = options.agent?.(toolbox);
  const { app, idle } = createSlackApp(
    { signingSecret: SECRET, botToken: 'xoxb-test', apiUrl: slack.apiUrl, logLevel: LogLevel.ERROR },
    { toolbox, approvals: new Approvals(), ...(agent ? { agent } : {}) },
  );
  const server = (await app.start(0)) as Server;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`;
  cleanups.push(async () => {
    await app.stop();
    await slack.stop();
  });

  let responses = 0;
  return {
    slack,
    url,
    mcp,
    toolbox,
    idle,
    command: (commandText, userId = 'U1') =>
      postSigned(url, SECRET, slashCommandBody({ text: commandText, userId, channelId: 'C1', responseUrl: slack.responseUrl(`r${++responses}`) }), FORM),
    click: (traffic, userId = 'U1') =>
      postSigned(
        url,
        SECRET,
        buttonClickBody({ actionId: ACTION_APPROVE, value: approveValue(traffic) ?? '', userId, channelId: 'C1', responseUrl: slack.responseUrl(`r${++responses}`) }),
        FORM,
      ),
  };
}

function blocksOf(traffic: SlackTraffic): Block[] {
  return (traffic.body.blocks ?? []) as Block[];
}

function textOf(traffic: SlackTraffic): string {
  return blocksToText(blocksOf(traffic));
}

function approveValue(traffic: SlackTraffic): string | undefined {
  for (const block of blocksOf(traffic)) {
    if (block.type !== 'actions') continue;
    for (const element of block.elements) if (element.type === 'button' && element.action_id === ACTION_APPROVE) return element.value;
  }
  return undefined;
}

const hasButtons = (traffic: SlackTraffic) => approveValue(traffic) !== undefined;
const replies = (slack: MockSlack) => slack.traffic.filter((traffic) => traffic.kind === 'respond' || traffic.target === 'chat.postMessage');

describe('Slack request signatures', () => {
  it('match what Bolt verifies', () => {
    const body = 'command=%2Fce&text=help';
    const headers = signSlackRequest(SECRET, body, 1_700_000_000);
    expect(() =>
      verifySlackRequest({
        signingSecret: SECRET,
        body,
        headers: { 'x-slack-signature': headers['x-slack-signature'], 'x-slack-request-timestamp': 1_700_000_000 },
        nowMilliseconds: 1_700_000_010_000,
      }),
    ).not.toThrow();
    expect(() =>
      verifySlackRequest({
        signingSecret: 'other-secret',
        body,
        headers: { 'x-slack-signature': headers['x-slack-signature'], 'x-slack-request-timestamp': 1_700_000_000 },
        nowMilliseconds: 1_700_000_010_000,
      }),
    ).toThrow();
  });

  it('are required by the running app: wrong secret, tampered body and stale requests get 401', async () => {
    const { url, slack } = await startHarness();
    const body = slashCommandBody({ text: 'company acme.example', userId: 'U1', channelId: 'C1', responseUrl: slack.responseUrl('x') });

    expect((await postSigned(url, 'wrong-secret', body, FORM)).status).toBe(401);
    const tampered = await fetch(url, { method: 'POST', headers: { 'content-type': FORM, ...signSlackRequest(SECRET, body) }, body: `${body}&extra=1` });
    expect(tampered.status).toBe(401);
    const stale = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': FORM, ...signSlackRequest(SECRET, body, Math.floor(Date.now() / 1000) - 10 * 60) },
      body,
    });
    expect(stale.status).toBe(401);
    // Correctly signed, but stamped in the future: Bolt alone would accept this.
    const future = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': FORM, ...signSlackRequest(SECRET, body, Math.floor(Date.now() / 1000) + 24 * 60 * 60) },
      body,
    });
    expect(future.status).toBe(401);
    expect(replies(slack)).toHaveLength(0);
  });

  it('accept a small clock difference either way', async () => {
    const { url, slack } = await startHarness();
    for (const [offset, id] of [[200, 'ahead'], [-200, 'behind']] as const) {
      const body = slashCommandBody({ text: 'help', userId: 'U1', channelId: 'C1', responseUrl: slack.responseUrl(id) });
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': FORM, ...signSlackRequest(SECRET, body, Math.floor(Date.now() / 1000) + offset) },
        body,
      });
      expect(response.status).toBe(200);
      await slack.waitFor((traffic) => traffic.target === id);
    }
  });

  it('allow at most 5 minutes of clock difference', () => {
    const now = 1_700_000_000_000;
    expect(isFreshTimestamp({ 'x-slack-request-timestamp': '1700000300' }, now)).toBe(true);
    expect(isFreshTimestamp({ 'x-slack-request-timestamp': '1699999700' }, now)).toBe(true);
    expect(isFreshTimestamp({ 'x-slack-request-timestamp': '1700000301' }, now)).toBe(false);
    expect(isFreshTimestamp({ 'x-slack-request-timestamp': '1699999699' }, now)).toBe(false);
    expect(isFreshTimestamp({ 'x-slack-request-timestamp': '1.7e9' }, now)).toBe(false);
    expect(isFreshTimestamp({}, now)).toBe(false);
  });
});

describe('/ce commands', () => {
  it('posts a free count to the channel', async () => {
    const harness = await startHarness();
    expect((await harness.command('count fintech startups in Berlin')).status).toBe(200);
    const reply = await harness.slack.waitFor((traffic) => traffic.kind === 'respond');
    expect(reply.body.response_type).toBe('in_channel');
    expect(textOf(reply)).toContain('*120* companies match _fintech startups in Berlin_.');
    expect(textOf(reply)).toContain('• city: 37140');
  });

  it('enriches a company for 1 credit', async () => {
    const harness = await startHarness();
    await harness.command('company acme.example');
    const reply = await harness.slack.waitFor((traffic) => traffic.kind === 'respond');
    expect(textOf(reply)).toContain('# Acme');
    expect(harness.toolbox.spentToday('U1')).toBe(1);
  });

  it('reports an unknown domain privately, with no charge', async () => {
    const harness = await startHarness();
    await harness.command('company missing.example');
    const reply = await harness.slack.waitFor((traffic) => traffic.kind === 'respond');
    expect(reply.body.response_type).toBe('ephemeral');
    expect(textOf(reply)).toContain('not found in the database. No credits were charged.');
  });

  it('answers bad input with usage, without calling any tool', async () => {
    const harness = await startHarness();
    await harness.command('people stripe.com');
    const reply = await harness.slack.waitFor((traffic) => traffic.kind === 'respond');
    expect(textOf(reply)).toContain('Usage: `/ce people <domain> <role words> [n]`');
    expect(harness.mcp.calls).toHaveLength(0);
  });

  it('fetches people only after the requester clicks Approve', async () => {
    const harness = await startHarness();
    await harness.command('people acme.example vp sales');

    const prompt = await harness.slack.waitFor(hasButtons);
    expect(prompt.body.response_type).toBe('ephemeral');
    expect(textOf(prompt)).toContain('*2* people at acme.example match _vp sales_ (free count). Fetch 2?');
    expect(textOf(prompt)).toContain('Estimated cost: up to *4 credits*');
    expect(harness.mcp.calls).toHaveLength(0);

    // Someone else cannot approve another person's spend.
    await harness.click(prompt, 'U2');
    const refusal = await harness.slack.waitFor((traffic) => textOf(traffic).includes('Only <@U1>'));
    expect(refusal.body).toMatchObject({ response_type: 'ephemeral', replace_original: false });
    expect(harness.mcp.calls).toHaveLength(0);

    await harness.click(prompt, 'U1');
    const result = await harness.slack.waitFor((traffic) => traffic.body.response_type === 'in_channel');
    await harness.idle();

    expect(harness.slack.traffic.find((traffic) => traffic.body.replace_original === true && textOf(traffic).includes('Approved by'))).toBeDefined();
    expect(textOf(result)).toContain('*People at acme.example matching "vp sales"*');
    expect(textOf(result)).toContain('4 credits spent');
    expect(harness.mcp.calls).toEqual([
      { name: 'search_people', args: { domains: ['acme.example'], seniority: ['vp'], department: ['sales'], pageSize: 2 } },
    ]);

    // A second click finds nothing to approve and charges nothing more.
    await harness.click(prompt, 'U1');
    await harness.slack.waitFor((traffic) => textOf(traffic).includes('expired or was already handled'));
    expect(harness.mcp.calls).toHaveLength(1);
  });

  it('attaches a CSV when there are more than 10 rows', async () => {
    const harness = await startHarness({ people: 40 });
    await harness.command('people acme.example vp sales 12');
    await harness.click(await harness.slack.waitFor(hasButtons));
    const upload = await harness.slack.waitFor((traffic) => traffic.kind === 'upload');
    await harness.idle();

    const lines = String(upload.body.content).trim().split('\r\n');
    expect(lines[0]).toBe('name,position,seniority,department,company,company_domain,country,linkedin_url');
    expect(lines).toHaveLength(13);
    const completion = harness.slack.traffic.find((traffic) => traffic.target === 'files.completeUploadExternal');
    expect(completion?.body.channel_id).toBe('C1');
    const result = harness.slack.traffic.find((traffic) => traffic.body.response_type === 'in_channel');
    expect(textOf(result!)).toContain('Showing 10 of 12; the full list is in the CSV below.');
  });

  it('skips the paid fetch when the free count is 0', async () => {
    const harness = await startHarness({ people: 0 });
    await harness.command('people acme.example chief vibes officer');
    const reply = await harness.slack.waitFor((traffic) => traffic.kind === 'respond');
    expect(textOf(reply)).toContain('Nothing to fetch, no credits spent.');
    expect(harness.mcp.calls).toHaveLength(0);
  });
});

describe('@mentions', () => {
  const mention = (harness: Harness, ts = '1700000000.000001') =>
    postSigned(harness.url, SECRET, appMentionBody({ text: '<@U0BOT> VPs of sales at Acme?', userId: 'U1', channelId: 'C1', ts }), 'application/json');

  it('explain how to turn agent mode on when there is no Anthropic key', async () => {
    const harness = await startHarness();
    await mention(harness);
    const reply = await harness.slack.waitFor((traffic) => traffic.target === 'chat.postMessage');
    expect(reply.body.thread_ts).toBe('1700000000.000001');
    expect(textOf(reply)).toContain('Agent mode is off');
  });

  it('show the plan, wait for Approve, then answer in the thread with a CSV', async () => {
    const { anthropic } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'count_people', { semanticQuery: 'VPs of sales at Acme' })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Fetching 12 of them.'), toolUse('t2', 'search_people', { seniority: ['vp'], pageSize: 12 })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Acme has **12** sales VPs.')], stop_reason: 'end_turn' }),
    ]);
    const harness = await startHarness({ agent: (toolbox) => new GtmAgent({ anthropic, toolbox }) });
    expect((await mention(harness)).status).toBe(200);

    const plan = await harness.slack.waitFor(hasButtons);
    expect(plan.body.thread_ts).toBe('1700000000.000001');
    expect(textOf(plan)).toContain('Fetching 12 of them.');
    expect(textOf(plan)).toContain('[Approve 24 credits] [Cancel]');
    expect(harness.mcp.calls).toHaveLength(0);

    await harness.click(plan);
    const answer = await harness.slack.waitFor((traffic) => blocksOf(traffic)[0]?.type === 'markdown' && textOf(traffic).includes('sales VPs'));
    await harness.slack.waitFor((traffic) => traffic.kind === 'upload');
    await harness.idle();

    expect(textOf(answer)).toContain('*People (12)*');
    expect(textOf(answer)).toContain('24 credits spent on this question');
    expect(harness.toolbox.spentToday('U1')).toBe(24);
    const completion = harness.slack.traffic.find((traffic) => traffic.target === 'files.completeUploadExternal');
    expect(completion?.body).toMatchObject({ channel_id: 'C1', thread_ts: '1700000000.000001' });
  });

  it('answer a redelivered event only once', async () => {
    const { anthropic, requests } = scriptedClaude([() => ({ content: [text('Hello.')], stop_reason: 'end_turn' })]);
    const harness = await startHarness({ agent: (toolbox) => new GtmAgent({ anthropic, toolbox }) });
    await mention(harness, '1700000000.000009');
    await mention(harness, '1700000000.000009');
    await harness.slack.waitFor((traffic) => blocksOf(traffic)[0]?.type === 'markdown');
    await harness.idle();
    expect(requests).toHaveLength(1);
  });
});
