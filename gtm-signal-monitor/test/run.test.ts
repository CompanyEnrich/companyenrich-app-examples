import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthenticationError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/lib/config.js';
import { CreditBudget, searchCharge } from '../src/lib/credits.js';
import { describeError } from '../src/lib/errors.js';
import { runMonitor } from '../src/lib/run.js';
import { type AccountChangesState, type NewLeadersState, loadState } from '../src/lib/state.js';
import { createFakeApi, fakeCompany, fakePerson, jsonResponse } from './helpers/fake-api.js';

const NOW = new Date('2026-11-11T08:00:00Z');

const CONFIG = parseConfig(`
watchers:
  - id: funded
    type: new-companies
    title: Funded companies
    maxResultsPerRun: 2
    query:
      filter: { country: US }
  - id: leaders
    type: new-leaders
    title: New leaders
    domains: [stripe.com]
    maxResultsPerRun: 5
  - id: accounts
    type: account-changes
    title: Account changes
    domains: [stripe.com, notion.so]
`);

/** A small fake world: 3 matching companies, 1 new leader, 2 enrichable accounts. */
function world() {
  const companies = ['a.com', 'b.com', 'c.com'];
  const excluded = (body: any): string[] => body.filter?.domain?.notIn ?? [];
  const leader = fakePerson(7, 'stripe.com', 'VP Sales', '2026-10-01');
  const leadersIn = (body: any) => (body.filter.currentPositionStartDate.after === '2026-10-01' ? [leader] : []);
  return createFakeApi({
    'POST /v2/companies/search/count': (body) => {
      const count = companies.filter((domain) => !excluded(body).includes(domain)).length;
      return { count, total: count };
    },
    'POST /v2/companies/search': (body) => ({
      items: companies
        .filter((domain) => !excluded(body).includes(domain))
        .slice(0, body.pageSize)
        .map((domain) => fakeCompany(domain)),
    }),
    'POST /v2/people/search/count': (body) => ({ count: leadersIn(body).length, total: leadersIn(body).length }),
    'POST /v2/people/search': (body) => ({ items: leadersIn(body).slice(0, body.pageSize) }),
    'POST /v2/companies/enrich/batch': (body) => ({
      items: body.domains.map((domain: string) => ({ domain, status: 'found', company: fakeCompany(domain) })),
    }),
  });
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'gtm-run-'));
  return { statePath: join(dir, 'state', 'state.json'), outputDir: join(dir, 'output') };
}

describe('credit budget', () => {
  it('grants whole units in order until the cap is used', () => {
    const budget = new CreditBudget(10);
    expect(budget.grant({ units: 3, unitCost: 2 })).toBe(3);
    expect(budget.grant({ units: 5, unitCost: 3 })).toBe(1);
    expect(budget.grant({ units: 2, unitCost: 1 })).toBe(1);
    expect(budget.grant({ units: 1, unitCost: 1 })).toBe(0);
    expect(budget.total).toBe(10);
  });

  it('rounds a grant down to whole chunks and leaves the rest for later requests', () => {
    const budget = new CreditBudget(4);
    // Wants 3 units of 2 credits that only work together; 2 affordable units are useless to it.
    expect(budget.grant({ units: 3, unitCost: 2, fit: (granted) => (granted >= 3 ? 3 : 0) })).toBe(0);
    expect(budget.grant({ units: 2, unitCost: 2 })).toBe(2);
    expect(budget.total).toBe(4);
  });

  it('bills an empty search page at one result', () => {
    expect(searchCharge(0, 2)).toBe(2);
    expect(searchCharge(3, 1, 2)).toBe(9);
  });
});

describe('runMonitor', () => {
  it('--dry-run makes only free calls and writes nothing', async () => {
    const api = world();
    const lines: string[] = [];
    const { statePath, outputDir } = paths();
    const result = await runMonitor({
      client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 50, dryRun: true, now: NOW, log: (line) => lines.push(line),
    });

    expect(result).toEqual({ creditsCharged: 0, failed: false });
    expect(api.paidCalls()).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(outputDir)).toBe(false);
    expect(lines.find((line) => line.startsWith('Credit plan'))).toBe(
      [
        'Credit plan (worst case, cap 50):',
        '  funded    3 new matches -> 2 companies x 1 = 2 credits',
        '  leaders   1 new person at 1 account since 2026-10-01 -> 1 person x 2 = 2 credits',
        '  accounts  2 of 2 accounts due for a refresh -> 2 accounts x 4 = 8 credits',
        '  Total: up to 12 credits.',
      ].join('\n'),
    );
  });

  it('runs, saves state and the digest, then a second run is quiet and free', async () => {
    const api = world();
    const { statePath, outputDir } = paths();
    const options = { client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 50, log: () => {} };

    const first = await runMonitor({ ...options, now: NOW });
    expect(first.creditsCharged).toBe(2 + 2 + 8);
    expect(first.digest?.reports.map((report) => report.signals.length)).toEqual([2, 1, 0]);
    expect(loadState(statePath).watchers.funded).toMatchObject({ seenDomains: ['a.com', 'b.com'] });
    const markdown = readFileSync(first.digestPath!, 'utf8');
    expect(markdown).toContain('# GTM signals: 2026-11-11');
    expect(markdown).toContain('_Baseline recorded for 2 accounts. Changes show up from the next refresh._');

    const paidBefore = api.paidCalls().length;
    const second = await runMonitor({ ...options, now: new Date('2026-11-11T09:00:00Z') });
    // The third company was carried over from the first run; nothing else is new.
    expect(second.digest?.reports.map((report) => report.signals.map((signal) => signal.domain))).toEqual([['c.com'], [], []]);
    expect(api.paidCalls().length - paidBefore).toBe(1);

    const third = await runMonitor({ ...options, now: new Date('2026-11-11T10:00:00Z') });
    expect(third.creditsCharged).toBe(0);
    expect(api.paidCalls().length - paidBefore).toBe(1);
    expect(readFileSync(third.digestPath!, 'utf8')).toContain('No new signals from 3 watchers. Credits used: 0 (cap 50).');
  });

  it('defers watchers that do not fit under --max-credits and leaves their state alone', async () => {
    const api = world();
    const { statePath, outputDir } = paths();
    const result = await runMonitor({ client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 5, now: NOW, log: () => {} });

    expect(result.creditsCharged).toBeLessThanOrEqual(5);
    expect(result.digest?.reports[2]?.notes).toEqual(['Deferred by the credit cap: 2 accounts wait for the next run.']);
    expect(api.callsTo('POST /v2/companies/enrich/batch')).toEqual([]);
    expect(loadState(statePath).watchers.accounts).toBeUndefined();
  });

  it('--reset-state forgets what the selected watcher has seen', async () => {
    const api = world();
    const { statePath, outputDir } = paths();
    const options = { client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 50, log: () => {} };
    await runMonitor({ ...options, now: NOW });

    const reset = await runMonitor({ ...options, now: NOW, resetState: true, watcherIds: ['funded'] });
    expect(reset.digest?.reports.map((report) => report.id)).toEqual(['funded']);
    expect(reset.digest?.reports[0]?.signals.map((signal) => signal.domain)).toEqual(['a.com', 'b.com']);
    expect(loadState(statePath).watchers.accounts).toBeDefined();
  });

  it('reports a rejected filter for one watcher and still runs the others', async () => {
    const api = createFakeApi({
      'POST /v2/companies/search/count': () =>
        jsonResponse(422, { title: 'Validation failed', status: 422, errors: { 'filter.country': ['Unknown country code "USA".'] } }),
      'POST /v2/companies/enrich/batch': (body) => ({
        items: body.domains.map((domain: string) => ({ domain, status: 'found', company: fakeCompany(domain) })),
      }),
      'POST /v2/people/search/count': () => ({ count: 0, total: 0 }),
    });
    const { statePath, outputDir } = paths();
    const result = await runMonitor({ client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 50, now: NOW, log: () => {} });

    expect(result.failed).toBe(true);
    expect(result.digest?.reports[0]?.error).toBe(
      'CompanyEnrich rejected the request (422): Validation failed; filter.country: Unknown country code "USA".',
    );
    expect(result.digest?.reports[2]?.notes[0]).toMatch(/Baseline recorded/);
  });

  it('stops paid calls after the account runs out of credits', async () => {
    const api = createFakeApi({
      'POST /v2/companies/search/count': () => ({ count: 1, total: 1 }),
      'POST /v2/companies/search': () => jsonResponse(402, { title: 'Payment Required', status: 402 }),
      'POST /v2/people/search/count': () => ({ count: 0, total: 0 }),
    });
    const { statePath, outputDir } = paths();
    const result = await runMonitor({ client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 50, now: NOW, log: () => {} });

    expect(result.digest?.reports[0]?.error).toMatch(/402/);
    expect(result.digest?.reports[2]?.error).toBe('Skipped: the account ran out of credits earlier in this run.');
    expect(api.callsTo('POST /v2/companies/enrich/batch')).toEqual([]);
  });

  it('fails fast with a one-line message for a bad API key', async () => {
    const api = createFakeApi({ 'GET /v2/me': () => jsonResponse(401, { title: 'Unauthorized', status: 401 }) });
    const { statePath, outputDir } = paths();
    const run = runMonitor({ client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 50, now: NOW, log: () => {} });
    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(describeError(error)).toMatch(/^CompanyEnrich rejected the API key \(401\)/);
  });

  it('points at the config when the API rejects a filter without details', async () => {
    const api = createFakeApi({ 'POST /v2/companies/search/count': () => new Response('', { status: 400 }) });
    const error = await api.client.companies.count({}).catch((caught: unknown) => caught);
    expect(describeError(error)).toBe(
      'CompanyEnrich rejected the request (400): check the filter values in the config against https://docs.companyenrich.com',
    );
  });

  it('keeps paid progress and reports the real spend when a later page fails', async () => {
    const config = parseConfig(`
watchers:
  - id: leaders
    type: new-leaders
    domains: [stripe.com, notion.so]
`);
    const people = [fakePerson(1, 'stripe.com', 'VP Sales', '2026-10-01'), fakePerson(2, 'notion.so', 'VP Marketing', '2026-10-01')];
    const atDomains = (body: any) =>
      people.filter((person) => {
        const role = person.experiences[0]!;
        const { after, before } = body.filter.currentPositionStartDate;
        return body.filter.domain.includes(role.company!.domain) && role.startDate! >= after && role.startDate! <= before;
      });
    let notionFails = true;
    const api = createFakeApi({
      'POST /v2/people/search/count': (body) => ({ count: atDomains(body).length, total: atDomains(body).length }),
      'POST /v2/people/search': (body) =>
        notionFails && body.filter.domain.includes('notion.so')
          ? jsonResponse(500, { title: 'Internal Server Error', status: 500 })
          : { items: atDomains(body) },
    });
    const { statePath, outputDir } = paths();
    const options = { client: api.client, config, statePath, outputDir, maxCredits: 50, log: () => {} };

    const failed = await runMonitor({ ...options, now: NOW });
    expect(failed.failed).toBe(true);
    expect(failed.creditsCharged).toBe(2);
    expect(failed.digest?.reports[0]?.signals.map((signal) => signal.title)).toEqual(['Person 1']);
    expect(failed.digest?.reports[0]?.error).toMatch(/^CompanyEnrich API error 500/);
    const saved = loadState(statePath).watchers.leaders as NewLeadersState;
    expect(saved.seen.map((entry) => entry.domain)).toEqual(['stripe.com']);

    notionFails = false;
    const retry = await runMonitor({ ...options, now: new Date('2026-11-11T09:00:00Z') });
    expect(retry.digest?.reports[0]?.signals.map((signal) => signal.title)).toEqual(['Person 2']);
    expect(api.callsTo('POST /v2/people/search').map((call) => call.body.filter.domain)).toEqual([
      ['stripe.com'],
      ['notion.so'],
      ['notion.so'],
    ]);
  });

  it('saves every enrichment batch that succeeded before a failure', async () => {
    const domains = Array.from({ length: 60 }, (_, index) => `co${index}.com`);
    const config = parseConfig(`
watchers:
  - id: accounts
    type: account-changes
    domains: [${domains.join(', ')}]
`);
    let batches = 0;
    const api = createFakeApi({
      'POST /v2/companies/enrich/batch': (body) =>
        ++batches === 2
          ? jsonResponse(500, { title: 'Internal Server Error', status: 500 })
          : { items: body.domains.map((domain: string) => ({ domain, status: 'found', company: fakeCompany(domain) })) },
    });
    const { statePath, outputDir } = paths();
    const result = await runMonitor({ client: api.client, config, statePath, outputDir, maxCredits: 300, now: NOW, log: () => {} });

    expect(result.creditsCharged).toBe(50 * 4);
    expect(result.digest?.reports[0]?.error).toMatch(/500/);
    expect(readFileSync(result.digestPath!, 'utf8')).toContain('Credits used: 200 (cap 300).');
    const saved = loadState(statePath).watchers.accounts as AccountChangesState;
    expect(Object.keys(saved.snapshots)).toHaveLength(50);
  });

  it('--reset-state recovers from a corrupt state file', async () => {
    const { statePath, outputDir } = paths();
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, '{ not json');
    const options = { client: world().client, config: CONFIG, statePath, outputDir, maxCredits: 50, now: NOW, log: () => {} };

    await expect(runMonitor(options)).rejects.toThrow('Delete it, or run with --reset-state (without --watcher) to start over.');
    await expect(runMonitor({ ...options, resetState: true, watcherIds: ['funded'] })).rejects.toThrow(/not valid JSON/);
    const result = await runMonitor({ ...options, resetState: true });
    expect(result.failed).toBe(false);
    expect(Object.keys(loadState(statePath).watchers)).toEqual(['funded', 'leaders', 'accounts']);
  });

  it('rejects unknown watcher ids before calling the API', async () => {
    const api = world();
    const { statePath, outputDir } = paths();
    await expect(
      runMonitor({ client: api.client, config: CONFIG, statePath, outputDir, maxCredits: 50, watcherIds: ['nope'], log: () => {} }),
    ).rejects.toThrow('Unknown watcher id: nope. Configured watchers: funded, leaders, accounts.');
    expect(api.calls).toEqual([]);
  });
});
