import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthenticationError, type Person } from '@companyenrich/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CheckOptions, runCheck } from '../src/lib/check.js';
import { parseConfig } from '../src/lib/config.js';
import { type ChampionRecord, loadState, saveState } from '../src/lib/state.js';
import { type Handler, fakeApi, json, notFound } from './helpers/fake-api.js';
import { baseline, company, person, role } from './helpers/fixtures.js';

const config = parseConfig({
  icp: {
    employees: { weight: 50, match: ['201-500'] },
    country: { weight: 50, match: ['US'] },
  },
  buyerPersona: { seniority: ['vp', 'director'], department: ['sales'] },
});

const NOW = new Date('2026-11-11T08:00:00Z');
const LAST_MONTH = '2026-10-01T08:00:00.000Z';

function record(personId: string, overrides: Partial<ChampionRecord> = {}): ChampionRecord {
  return {
    key: `id:${personId}`,
    personId,
    accountDomain: 'acme.example',
    dealName: `Deal ${personId}`,
    owner: 'alex@yourco.example',
    baseline: baseline(),
    lastCheckedAt: LAST_MONTH,
    ...overrides,
  };
}

const stayed = person([role('acme.example')], { id: 1, name: 'Stay Put' });
const moved = person([role('globex.example', { position: 'VP Sales', seniority: 'vp', start: '2026-09-01' }), role('acme.example', { end: '2026-08-01' })], {
  id: 2,
  name: 'Jane Champion',
});

function routes(people: Record<string, Person>, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /v2/people/:id': ({ params }) => people[params[0]!] ?? notFound(),
    'GET /v2/companies/enrich': ({ url }) => company(url.searchParams.get('domain')!),
    'POST /v2/people/search/count': () => ({ count: 12, total: 12 }),
    'POST /v2/people/search': ({ body }) => ({
      items: Array.from({ length: body.pageSize }, (_, index) => person([role('globex.example')], { id: 900 + index, name: `Contact ${index}` })),
    }),
    ...extra,
  };
}

let dir: string;
let statePath: string;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'champion-tracker-'));
  statePath = join(dir, 'state.json');
  lines = [];
});

function options(client: CheckOptions['client'], overrides: Partial<CheckOptions> = {}): CheckOptions {
  return {
    client,
    config,
    statePath,
    outputDir: join(dir, 'output'),
    maxCredits: 40,
    checkEveryDays: 30,
    pendingOnly: false,
    withContacts: false,
    dryRun: false,
    now: NOW,
    log: (line) => lines.push(line),
    ...overrides,
  };
}

describe('runCheck', () => {
  it('reports no changes and spends only the profile fetches', async () => {
    saveState(statePath, { version: 1, champions: [record('1')] });
    const api = fakeApi(routes({ 1: stayed }));
    const { report, digestPath } = await runCheck(options(api.client));

    expect(report).toMatchObject({ checked: 1, unchanged: 1, alerts: [], spent: 2 });
    expect(api.callsTo('GET', '/v2/companies')).toHaveLength(0);
    expect(readFileSync(digestPath!, 'utf8')).toMatch(/No changes: nobody moved, got promoted or left/);
    expect(loadState(statePath)!.champions[0]!.lastCheckedAt).toBe(NOW.toISOString());
  });

  it('runs the move flow: enrich the new company, score it and count the buyer persona there', async () => {
    saveState(statePath, { version: 1, champions: [record('2')] });
    const api = fakeApi(routes({ 2: moved }));
    const { report, digestPath } = await runCheck(options(api.client));

    expect(api.callsTo('GET', '/v2/companies/enrich')[0]!.url.searchParams.get('domain')).toBe('globex.example');
    expect(api.callsTo('POST', '/v2/people/search/count')[0]!.body).toEqual({
      filter: { companyId: 'co-globex.example', seniority: ['vp', 'director'], department: ['sales'], query: { notIn: ['"Jane Champion"'] } },
    });
    expect(api.calls.some((call) => call.path === '/v2/people/search')).toBe(false);
    expect(report!.spent).toBe(3);

    const alert = report!.alerts[0]!;
    expect(alert.change.kind).toBe('moved');
    expect(alert.research).toMatchObject({ persona: { total: 12, accessible: 12 }, icp: { score: 100, fit: 'strong' }, contacts: [] });
    expect(loadState(statePath)!.champions[0]!.baseline).toMatchObject({ companyDomain: 'globex.example', position: 'VP Sales' });
    expect(readFileSync(digestPath!, 'utf8')).toMatch(/### Moved: Jane Champion is now at Globex/);
  });

  it('reports a departure, without paying for enrichment, when only a side business they already had remains', async () => {
    const sideBusiness = role('consulting.example', { position: 'Owner', seniority: 'owner', start: '2019-01-01' });
    const left = person([role('acme.example', { end: '2026-09-01' }), sideBusiness], { id: 4, name: 'Side Business' });
    saveState(statePath, { version: 1, champions: [record('4', { baseline: baseline({ otherCurrentCompanies: ['co-consulting.example'] }) })] });
    const api = fakeApi(routes({ 4: left }));
    const { report, digestPath } = await runCheck(options(api.client));

    expect(report!.alerts[0]!.change.kind).toBe('left');
    expect(api.callsTo('GET', '/v2/companies')).toHaveLength(0);
    expect(api.callsTo('POST', '/v2/people/search')).toHaveLength(0);
    expect(report!.spent).toBe(2);
    expect(readFileSync(digestPath!, 'utf8')).toContain('- Still lists roles they already had: Owner at Consulting');
  });

  it('fetches up to 3 contacts at the new company with --with-contacts', async () => {
    saveState(statePath, { version: 1, champions: [record('2')] });
    const api = fakeApi(routes({ 2: moved }));
    const { report } = await runCheck(options(api.client, { withContacts: true }));

    const search = api.calls.find((call) => call.path === '/v2/people/search')!;
    expect(search.body.pageSize).toBe(3);
    expect(report!.alerts[0]!.research!.contacts.map((contact) => contact.name)).toEqual(['Contact 0', 'Contact 1', 'Contact 2']);
    expect(report!.spent).toBe(2 + 1 + 6);
  });

  it('shows contacts by their title at the new company and flags ones you already track', async () => {
    const otherChampion = person([role('globex.example', { position: 'CRO' })], { id: 1, name: 'Known Champion', position: 'Revenue leader | Speaker' });
    saveState(statePath, { version: 1, champions: [record('1', { lastCheckedAt: NOW.toISOString() }), record('2')] });
    const api = fakeApi(routes({ 2: moved }, { 'POST /v2/people/search/count': () => ({ count: 1, total: 1 }), 'POST /v2/people/search': () => ({ items: [otherChampion] }) }));
    const { report, digestPath } = await runCheck(options(api.client, { withContacts: true }));

    expect(report!.alerts[0]!.research!.contacts).toEqual([{ name: 'Known Champion', position: 'CRO', linkedinUrl: expect.any(String), isChampion: true }]);
    expect(readFileSync(digestPath!, 'utf8')).toMatch(/Contact: Known Champion, CRO, .* \(already one of your tracked champions\)/);
    expect(report!.spent).toBe(2 + 1 + 2);
  });

  it('never passes the credit cap and defers the rest to the next run', async () => {
    saveState(statePath, { version: 1, champions: [record('1'), record('2'), record('3')] });
    const api = fakeApi(routes({ 1: stayed, 2: moved, 3: stayed }));
    const { report, digestPath } = await runCheck(options(api.client, { maxCredits: 5 }));

    expect(report).toMatchObject({ checked: 2, deferred: 1, spent: 5 });
    expect(readFileSync(digestPath!, 'utf8')).toMatch(/1 due champions were not checked because of the 5-credit cap/);
    expect(loadState(statePath)!.champions[2]!.lastCheckedAt).toBe(LAST_MONTH);
  });

  it('dry run prints the plan, makes no paid calls and leaves state untouched', async () => {
    saveState(statePath, { version: 1, champions: [record('1'), record('2')] });
    const before = readFileSync(statePath, 'utf8');
    const api = fakeApi(routes({ 1: stayed, 2: moved }));
    const result = await runCheck(options(api.client, { dryRun: true }));

    expect(result.report).toBeNull();
    expect(api.calls.map((call) => call.path)).toEqual(['/v2/me']);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'output'))).toBe(false);
    expect(lines.join('\n')).toMatch(/Plan: check 2 champions at 2 credits each \(4 credits if nobody moved\)/);
  });

  it('only fetches champions that are due', async () => {
    saveState(statePath, { version: 1, champions: [record('1', { lastCheckedAt: '2026-11-01T00:00:00.000Z' })] });
    const api = fakeApi(routes({ 1: stayed }));
    const result = await runCheck(options(api.client));

    expect(result.report).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('lists a missing profile under "Needs attention" and retries it next run', async () => {
    saveState(statePath, { version: 1, champions: [record('404'), record('1')] });
    const api = fakeApi(routes({ 1: stayed }));
    const { report, digestPath } = await runCheck(options(api.client));

    expect(report).toMatchObject({ checked: 1, spent: 2 });
    expect(readFileSync(digestPath!, 'utf8')).toMatch(/## Needs attention[\s\S]*person 404: profile not found/);
    expect(loadState(statePath)!.champions[0]!.lastCheckedAt).toBe(LAST_MONTH);
  });

  it('rejects an invalid key before any paid call and leaves state untouched', async () => {
    saveState(statePath, { version: 1, champions: [record('1')] });
    const before = readFileSync(statePath, 'utf8');
    const api = fakeApi({ 'GET /v2/me': () => json(401, { title: 'Unauthorized', status: 401 }) });

    await expect(runCheck(options(api.client))).rejects.toBeInstanceOf(AuthenticationError);
    expect(api.calls).toHaveLength(1);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('stops when credits run out mid-run, keeping and reporting what was already paid for', async () => {
    saveState(statePath, { version: 1, champions: [record('1'), record('2'), record('3')] });
    const api = fakeApi({ 'GET /v2/people/:id': ({ params }) => (params[0] === '1' ? stayed : json(402, { title: 'Payment Required', status: 402 })) });
    const { report, digestPath } = await runCheck(options(api.client));

    expect(report).toMatchObject({ checked: 1, deferred: 2, spent: 2, stoppedBy: expect.stringMatching(/402/) });
    expect(api.callsTo('GET', '/v2/people/')).toHaveLength(2);
    const champions = loadState(statePath)!.champions;
    expect(champions.map((champion) => [champion.lastCheckedAt, champion.pendingCheck])).toEqual([
      [NOW.toISOString(), undefined],
      [LAST_MONTH, true],
      [LAST_MONTH, true],
    ]);
    expect(readFileSync(digestPath!, 'utf8')).toMatch(/Stopped early: CompanyEnrich returned 402[\s\S]*Once that is fixed, run "npm start -- check --pending-only --max-credits 5 --state '/);
  });

  it('resumes a capped run with --pending-only, checking only the pending champions whatever the interval', async () => {
    const champions = [
      record('1', { lastCheckedAt: '2026-08-03T08:00:00.000Z' }),
      record('2', { lastCheckedAt: '2026-08-03T08:00:00.000Z' }),
      // Not due on a 90-day cadence, but due on the default 30 days: a plain resume would buy it.
      record('3', { lastCheckedAt: '2026-09-22T08:00:00.000Z' }),
    ];
    saveState(statePath, { version: 1, champions });
    const first = fakeApi(routes({ 1: stayed, 2: stayed, 3: stayed }));
    const { report } = await runCheck(options(first.client, { checkEveryDays: 90, maxCredits: 3, configPath: 'my config/icp.json' }));
    expect(report).toMatchObject({
      checked: 1,
      deferred: 1,
      resumeCommand: `npm start -- check --pending-only --max-credits 3 --config 'my config/icp.json' --state '${statePath}'`,
    });

    // The printed command: --pending-only with the default interval.
    const second = fakeApi(routes({ 1: stayed, 2: stayed, 3: stayed }));
    const resumed = await runCheck(options(second.client, { pendingOnly: true, maxCredits: 3, now: new Date(NOW.getTime() + 60_000) }));
    expect(second.callsTo('GET', '/v2/people/').map((call) => call.params[0])).toEqual(['2']);
    expect(resumed.report).toMatchObject({ checked: 1, deferred: 0 });
    expect(loadState(statePath)!.champions.map((champion) => champion.pendingCheck)).toEqual([undefined, undefined, undefined]);
  });

  it('sends paid lookups without SDK retries, so one reservation matches one request', async () => {
    saveState(statePath, { version: 1, champions: [record('1')] });
    const api = fakeApi({ 'GET /v2/people/:id': () => json(500, { title: 'Server Error', status: 500 }) }, { maxRetries: 2 });
    const { report } = await runCheck(options(api.client));

    expect(api.callsTo('GET', '/v2/people/')).toHaveLength(1);
    expect(report!.problems[0]!.reason).toMatch(/500.*will retry next run/);
    expect(loadState(statePath)!.champions[0]!.pendingCheck).toBe(true);
  });

  it('counts a paid lookup that got no response as spent, so the cap still holds', async () => {
    saveState(statePath, { version: 1, champions: [record('1'), record('2')] });
    const api = fakeApi({
      'GET /v2/people/:id': ({ params }) => {
        if (params[0] === '1') throw new TypeError('socket hang up');
        return stayed;
      },
    });
    const { report } = await runCheck(options(api.client, { maxCredits: 5 }));

    expect(report).toMatchObject({ checked: 1, spent: 4, breakdown: 'people.get (no response) x1 = 2, people.get x1 = 2' });
    expect(report!.problems[0]!.reason).toMatch(/Could not reach the CompanyEnrich API.*will retry next run/);
  });

  it('retries a rate-limited paid lookup, which is never billed', async () => {
    saveState(statePath, { version: 1, champions: [record('1')] });
    let attempts = 0;
    const api = fakeApi({
      'GET /v2/people/:id': () => (++attempts === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }) : stayed),
    });
    const { report } = await runCheck(options(api.client));

    expect(attempts).toBe(2);
    expect(report).toMatchObject({ checked: 1, spent: 2 });
  });

  it('posts alerts to Slack as Block Kit when a webhook is set', async () => {
    saveState(statePath, { version: 1, champions: [record('2')] });
    const api = fakeApi(routes({ 2: moved }));
    const posts: { url: string; body: any }[] = [];
    const slackFetch: typeof fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('ok');
    };
    await runCheck(options(api.client, { slackWebhookUrl: 'https://hooks.slack.example/T/B/X', fetch: slackFetch }));

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'Champion digest, 2026-11-11' } });
    expect(posts[0]!.body.text).toMatch(/1 moved/);
  });

  it('does not post to Slack when nothing changed', async () => {
    saveState(statePath, { version: 1, champions: [record('1')] });
    const api = fakeApi(routes({ 1: stayed }));
    let posted = false;
    await runCheck(options(api.client, { slackWebhookUrl: 'https://hooks.slack.example/T/B/X', fetch: async () => ((posted = true), new Response('ok')) }));

    expect(posted).toBe(false);
  });
});
