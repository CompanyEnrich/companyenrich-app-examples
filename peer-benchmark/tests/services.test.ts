import { AuthenticationError, CompanyEnrich } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { CreditAllowance } from '@/lib/credits';
import { estimateBenchmark, runBenchmark } from '@/server/benchmark-service';
import { createState } from '@/server/state';
import { estimateSuggestions, fetchSuggestions } from '@/server/suggest-service';
import { ACME, BETA, GAMMA, fakeApi } from './fixtures';

/** The real SDK with its default retries, so `maxRetries: 0` on paid calls is what is being tested. */
function clientFor(api: ReturnType<typeof fakeApi>) {
  return new CompanyEnrich({ apiKey: 'test-key', fetch: api.fetch });
}

const request = { company: 'acme.com', peers: ['beta.io', 'gamma.com', 'nodata.dev'] };
const workforceCalls = (api: ReturnType<typeof fakeApi>) => api.calls.filter((call) => call.path === '/v2/companies/workforce');

function groupApi(options: { delayMs?: number } = {}) {
  return fakeApi({
    ...options,
    workforce: { 'acme.com': ACME, 'beta.io': BETA, 'gamma.com': GAMMA },
    autocomplete: {
      'acme.com': [{ domain: 'acme.com', name: 'Acme', logoUrl: 'https://logo.example/acme.png' }],
      'beta.io': [{ domain: 'beta.io', name: 'Beta', logoUrl: 'https://logo.example/beta.png' }],
    },
  });
}

describe('runBenchmark', () => {
  it('charges 1 credit per company found, excludes 404s for free, and builds insights', async () => {
    const api = groupApi();
    const allowance = new CreditAllowance(4);
    const run = await runBenchmark(clientFor(api), createState(), request, allowance);

    expect(run.creditsCharged).toBe(3);
    expect(allowance.spent).toBe(3);
    expect(run.cached).toBe(0);
    expect(run.benchmark.subject?.name).toBe('Acme');
    // No exact autocomplete match: the domain is the label.
    expect(run.companies.map((company) => company.name)).toEqual(['Acme', 'Beta', 'gamma.com', 'nodata.dev']);
    expect(run.benchmark.excluded).toEqual([
      { domain: 'nodata.dev', name: 'nodata.dev', role: 'peer', reason: 'no workforce data for this domain' },
    ]);
    expect(run.insights[0]).toMatch(/^Acme has 200 observed employees/);
    expect(workforceCalls(api)).toHaveLength(4);
  });

  it('serves a repeat run from the cache for free, including the 404', async () => {
    const api = groupApi();
    const client = clientFor(api);
    const state = createState();
    await runBenchmark(client, state, request, new CreditAllowance(4));
    const callsBefore = workforceCalls(api).length;

    expect(estimateBenchmark(state, [request.company, ...request.peers])).toMatchObject({ companies: 4, cached: 4, credits: 0 });
    const again = await runBenchmark(client, state, request, new CreditAllowance(0));
    expect(again.creditsCharged).toBe(0);
    expect(again.cached).toBe(4);
    expect(workforceCalls(api)).toHaveLength(callsBefore);
  });

  it('expires the cache after an hour', async () => {
    let now = 0;
    const state = createState({ now: () => now });
    await runBenchmark(clientFor(groupApi()), state, request, new CreditAllowance(4));
    now = 60 * 60 * 1000;
    expect(estimateBenchmark(state, ['acme.com']).credits).toBe(1);
  });

  it('does not reuse a cached response across a month boundary, when the API window moves', async () => {
    let now = Date.parse('2026-10-31T23:30:00Z');
    const state = createState({ now: () => now });
    await runBenchmark(clientFor(groupApi()), state, request, new CreditAllowance(4));
    expect(estimateBenchmark(state, ['acme.com']).credits).toBe(0);
    now = Date.parse('2026-11-01T00:10:00Z'); // 40 minutes later, still inside the hour
    expect(estimateBenchmark(state, ['acme.com']).credits).toBe(1);
  });

  it('settles calls already in flight and keeps their spend when a later call hits a bad key', async () => {
    const api = fakeApi({ workforce: { 'acme.com': ACME }, workforceStatusByDomain: { 'beta.io': 401 } });
    const state = createState();
    const allowance = new CreditAllowance(2);
    await expect(
      runBenchmark(clientFor(api), state, { company: 'acme.com', peers: ['beta.io'] }, allowance),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(allowance.spent).toBe(1);
    // What was paid for is kept: the next run reuses it.
    expect(estimateBenchmark(state, ['acme.com']).cached).toBe(1);
  });

  it('never spends past its allowance, excluding what it could not pay for', async () => {
    const api = groupApi();
    const run = await runBenchmark(clientFor(api), createState(), { company: 'acme.com', peers: ['beta.io', 'gamma.com'] }, new CreditAllowance(1));
    expect(run.creditsCharged).toBe(1);
    expect(workforceCalls(api)).toHaveLength(1);
    expect(run.benchmark.excluded).toHaveLength(2);
    expect(run.benchmark.excluded[0]?.reason).toMatch(/expired after the estimate/);
  });

  it('does not retry a failed paid call, and refunds it', async () => {
    const api = fakeApi({ workforceFailure: 500 });
    const allowance = new CreditAllowance(4);
    const run = await runBenchmark(clientFor(api), createState(), request, allowance);
    // The SDK would retry a GET twice by default; the paid workforce call goes out once per company.
    expect(workforceCalls(api)).toHaveLength(4);
    expect(allowance.spent).toBe(0);
    expect(run.benchmark.excluded[0]?.reason).toBe('CompanyEnrich server error, try again');
  });

  it('counts a call that may have been billed (dropped connection) as spent', async () => {
    const api = fakeApi({ workforceFailure: 'drop' });
    const run = await runBenchmark(clientFor(api), createState(), { company: 'acme.com', peers: ['beta.io'] }, new CreditAllowance(2));
    expect(workforceCalls(api)).toHaveLength(2);
    expect(run.creditsCharged).toBe(2);
    expect(run.benchmark.excluded.map((company) => company.reason)).toEqual(Array(2).fill('CompanyEnrich did not respond in time'));
  });

  it('stops on a bad API key and sends no further paid calls', async () => {
    const api = fakeApi({ failWith: 401 });
    const peers = Array.from({ length: 8 }, (_, index) => `peer${index}.com`);
    await expect(
      runBenchmark(clientFor(api), createState(), { company: 'acme.com', peers }, new CreditAllowance(9)),
    ).rejects.toBeInstanceOf(AuthenticationError);
    // Only the first wave of (free) name lookups goes out; the 401 stops everything queued behind it.
    expect(api.calls.length).toBeLessThanOrEqual(4);
    expect(workforceCalls(api)).toHaveLength(0);
  });

  it('excludes companies with a clear reason when credits run out', async () => {
    const run = await runBenchmark(clientFor(fakeApi({ failWith: 402 })), createState(), request, new CreditAllowance(4));
    expect(run.creditsCharged).toBe(0);
    expect(run.benchmark.excluded.map((company) => company.reason)).toEqual(Array(4).fill('out of credits'));
    expect(run.insights[0]).toMatch(/^There is no workforce data for acme.com/);
  });

  it('shares one limit of 4 parallel calls across concurrent runs', async () => {
    const api = groupApi({ delayMs: 5 });
    const client = clientFor(api);
    const state = createState();
    const peers = (prefix: string) => Array.from({ length: 8 }, (_, index) => `${prefix}${index}.com`);
    await Promise.all([
      runBenchmark(client, state, { company: 'acme.com', peers: peers('a') }, new CreditAllowance(9)),
      runBenchmark(client, state, { company: 'beta.io', peers: peers('b') }, new CreditAllowance(9)),
    ]);
    expect(api.concurrency.peak).toBe(4);
  });
});

describe('suggestions', () => {
  const query = { company: 'acme.com', count: 3, peers: ['beta.io'] };
  const searchApi = (available = 1200) =>
    fakeApi({
      count: () => ({ count: available, total: available }),
      search: () => ({
        items: [
          { id: 'c2', domain: 'zeta.com', name: 'Zeta', logoUrl: 'https://logo.example/z.png' },
          { id: 'c1', domain: 'eta.io', name: 'Eta', logoUrl: 'https://logo.example/e.png' },
          { id: 'c3', domain: 'theta.ai', name: '', logoUrl: '' },
        ],
        scores: { c1: 0.91, c2: 0.87, c3: 0.8 },
      }),
    });

  it('estimates with the free count, excluding the company and current peers', async () => {
    const api = searchApi();
    const estimate = await estimateSuggestions(clientFor(api), createState({ maxCredits: 50 }), query);
    expect(estimate).toEqual({ available: 1200, requested: 3, pageSize: 3, credits: 15, cached: false, budgetRemaining: 50 });
    expect(api.calls[0]).toMatchObject({
      path: '/v2/companies/search/count',
      body: { lookalike: { domains: ['acme.com'] }, filter: { domain: { notIn: ['acme.com', 'beta.io'] } } },
    });
  });

  it('asks only for as many as exist, and costs nothing when there are none', async () => {
    expect(await estimateSuggestions(clientFor(searchApi(2)), createState(), query)).toMatchObject({ pageSize: 2, credits: 10 });
    expect(await estimateSuggestions(clientFor(searchApi(0)), createState(), query)).toMatchObject({ pageSize: 0, credits: 0 });
  });

  it('keeps the API order and scores, and serves a repeat from the cache', async () => {
    const api = searchApi();
    const client = clientFor(api);
    const state = createState();
    const run = await fetchSuggestions(client, state, query, 3);

    expect(run.peers).toEqual([
      { domain: 'zeta.com', name: 'Zeta', logoUrl: 'https://logo.example/z.png', score: 0.87 },
      { domain: 'eta.io', name: 'Eta', logoUrl: 'https://logo.example/e.png', score: 0.91 },
      { domain: 'theta.ai', name: 'theta.ai', logoUrl: null, score: 0.8 },
    ]);
    expect(run.creditsCharged).toBe(15);
    expect(api.paidCalls()[0]?.body).toMatchObject({ pageSize: 3 });

    expect(await estimateSuggestions(client, state, query)).toMatchObject({ credits: 0, cached: true });
    expect(await fetchSuggestions(client, state, query, 3)).toMatchObject({ creditsCharged: 0, cached: true });
    expect(api.paidCalls()).toHaveLength(1);
  });
});
