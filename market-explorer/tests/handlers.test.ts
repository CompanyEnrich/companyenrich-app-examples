import { describe, expect, it } from 'vitest';
import * as handlers from '@/lib/handlers';
import { run } from '@/lib/handlers';
import { CreditBudget, SlidingWindowLimiter } from '@/lib/spend';
import { ME_WITH_PREVIEWS, fakeClient, testDeps } from './helpers';

const COUNT = 'POST /v2/companies/search/count';

describe('interpret', () => {
  it('returns the semantic count and the interpretation', async () => {
    const { client, calls } = fakeClient({
      [COUNT]: () => ({
        body: { count: 42, total: 42, interpretation: { filter: { country: { in: ['DE'] } } } },
      }),
    });
    const result = await run(handlers.interpret, { query: '  Series A fintech in Germany ' }, testDeps(client));
    expect(result).toEqual({
      status: 200,
      body: {
        query: 'Series A fintech in Germany',
        count: 42,
        total: 42,
        interpretation: { filter: { country: { in: ['DE'] } } },
      },
    });
    expect(calls[0]?.body).toEqual({ semantic: { query: 'Series A fintech in Germany' } });
  });

  it('rejects a query that is too short', async () => {
    const { client, calls } = fakeClient({});
    const result = await run(handlers.interpret, { query: 'ai' }, testDeps(client));
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('count', () => {
  it('counts a filter once and serves repeats from the cache', async () => {
    const { client, calls } = fakeClient({ [COUNT]: () => ({ body: { count: 2990, total: 2990 } }) });
    const deps = testDeps(client);
    const filter = { country: ['US'], technologies: { all: ['stripe', 'react'], notIn: ['shopify'] } };
    const first = await run(handlers.count, { filter }, deps);
    // Same filter with a different key order hits the cache.
    const second = await run(handlers.count, { filter: { technologies: filter.technologies, country: ['US'] } }, deps);
    expect(first).toEqual({ status: 200, body: { count: 2990, total: 2990 } });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ filter });
  });

  it('never forwards an invalid filter to the API', async () => {
    const { client, calls } = fakeClient({});
    const result = await run(handlers.count, { filter: { employees: ['lots'] } }, testDeps(client));
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('filter.employees');
    expect(calls).toHaveLength(0);
  });

  it('turns a bad API key into a one-line message', async () => {
    const { client } = fakeClient({ [COUNT]: () => ({ status: 401, body: { title: 'Unauthorized' } }) });
    const result = await run(handlers.count, { filter: {} }, testDeps(client));
    expect(result).toEqual({
      status: 401,
      body: { error: 'CompanyEnrich rejected the API key. Check COMPANYENRICH_API_KEY and restart the server.' },
    });
  });
});

describe('grid', () => {
  it('sends one count per cell with the segment applied', async () => {
    const { client, calls } = fakeClient({
      [COUNT]: ({ body }) => {
        const filter = (body as { filter: { country: string[] } }).filter;
        return { body: { count: filter.country[0] === 'US' ? 500 : 50, total: 0 } };
      },
    });
    const result = await run(
      handlers.grid,
      {
        filter: { categories: ['saas'] },
        rows: { dimension: 'country', values: ['US', 'DE'] },
        columns: { dimension: 'employees', values: ['11-50', '51-200'] },
      },
      testDeps(client),
    );
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.body)).toContainEqual({ filter: { categories: ['saas'], country: ['DE'], employees: ['51-200'] } });
    const body = result.body as { cells: { row: string; count: number }[]; requests: number };
    expect(body.requests).toBe(4);
    expect(body.cells.filter((c) => c.row === 'US').every((c) => c.count === 500)).toBe(true);
  });

  it('retries a rate-limited cell once and reports cells that still fail', async () => {
    let attempts = 0;
    const { client } = fakeClient({
      [COUNT]: () => (++attempts <= 3 ? { status: 429, body: { title: 'Too Many Requests' } } : { body: { count: 1, total: 1 } }),
    });
    const result = await run(
      handlers.grid,
      { filter: {}, rows: { dimension: 'revenue', values: ['under-1m'] }, columns: { dimension: 'categories', values: ['saas', 'b2b'] } },
      testDeps(client),
    );
    const cells = (result.body as { cells: { count: number | null }[] }).cells;
    expect(result.status).toBe(200);
    expect(cells.some((c) => c.count === null)).toBe(true);
  });

  it('refuses a grid larger than 8 x 8 before calling the API', async () => {
    const { client, calls } = fakeClient({});
    const result = await run(
      handlers.grid,
      {
        filter: {},
        rows: { dimension: 'fundingRounds', values: ['angel', 'seed', 'series_a', 'series_b', 'series_c', 'series_d', 'series_e', 'series_f', 'series_g'] },
        columns: { dimension: 'employees', values: ['1-10'] },
      },
      testDeps(client),
    );
    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('capabilities', () => {
  it('exposes only the previews flag, never the user id or credits', async () => {
    const { client } = fakeClient({ 'GET /v2/me': () => ({ body: ME_WITH_PREVIEWS }) });
    const result = await run(handlers.capabilities, undefined, testDeps(client));
    expect(result).toEqual({ status: 200, body: { previews: true } });
  });
});

describe('preview', () => {
  const PREVIEW = 'POST /v2/companies/search/preview';
  const item = { id: 'c1', name: 'Nextcloud', logoUrl: 'https://logo/c1', industry: 'Software', updatedAt: '2026-11-06' };

  it('returns free preview items when the plan allows it', async () => {
    const { client } = fakeClient({
      'GET /v2/me': () => ({ body: ME_WITH_PREVIEWS }),
      [PREVIEW]: () => ({ body: { items: [item], total: 1 } }),
    });
    const result = await run(handlers.preview, { filter: { country: ['DE'] } }, testDeps(client));
    expect(result.body).toMatchObject({ available: true, total: 1, items: [{ id: 'c1', name: 'Nextcloud', industry: 'Software' }] });
  });

  it('falls back with a clear reason when the preview endpoint returns 403', async () => {
    const { client } = fakeClient({
      'GET /v2/me': () => ({ body: ME_WITH_PREVIEWS }),
      [PREVIEW]: () => ({ status: 403, body: { title: 'Forbidden' } }),
    });
    const result = await run(handlers.preview, { filter: {} }, testDeps(client));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ available: false });
    expect((result.body as { reason: string }).reason).toContain('(403)');
  });

  it('does not call preview when the plan has no previews', async () => {
    const me = { ...ME_WITH_PREVIEWS, capabilities: { ...ME_WITH_PREVIEWS.capabilities, previews: false } };
    const { client, calls } = fakeClient({ 'GET /v2/me': () => ({ body: me }) });
    const result = await run(handlers.preview, { filter: {} }, testDeps(client));
    expect(result.body).toMatchObject({ available: false });
    expect(calls.map((c) => c.path)).toEqual(['/v2/me']);
  });
});

describe('search (paid)', () => {
  const SEARCH = 'POST /v2/companies/search';
  const company = {
    id: 'c1',
    name: 'Acme',
    domain: 'acme.com',
    website: 'https://acme.com',
    logoUrl: 'https://logo/c1',
    industry: 'Software',
    employees: '51-200',
    location: { country: { code: 'DE', name: 'Germany' } },
    updatedAt: '2026-11-01',
  };
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ ...company, id: `c${i + 1}` }));
  const confirmed = (pageSize = 3) => ({ filter: { country: ['DE'] }, pageSize, confirm: true });
  const ip = (clientIp: string) => ({ clientIp });

  it('checks the free count, then fetches at most the confirmed page size', async () => {
    const { client, calls } = fakeClient({
      [COUNT]: () => ({ body: { count: 120, total: 120 } }),
      [SEARCH]: () => ({ body: { items: items(3) } }),
    });
    const deps = testDeps(client, { budget: new CreditBudget(50) });
    const result = await run(handlers.search, confirmed(3), deps);
    expect(calls.map((c) => c.path)).toEqual(['/v2/companies/search/count', '/v2/companies/search']);
    expect(calls[1]?.body).toEqual({ filter: { country: ['DE'] }, pageSize: 3 });
    expect(result.body).toMatchObject({ matches: 120, credits: 3, skipped: false });
    expect((result.body as { items: unknown[] }).items[0]).toEqual({
      id: 'c1',
      name: 'Acme',
      logoUrl: 'https://logo/c1',
      industry: 'Software',
      domain: 'acme.com',
      country: 'Germany',
      employees: '51-200',
    });
    expect(deps.budget.remaining()).toBe(47);
  });

  it('is off unless enabled, and says how to enable it', async () => {
    const { client, calls } = fakeClient({});
    const result = await run(handlers.search, confirmed(), testDeps(client, { paidSearchEnabled: false }));
    expect(result).toEqual({
      status: 403,
      body: { error: 'Paid search is turned off on this server. Set ENABLE_PAID_SEARCH=true to allow it.' },
    });
    expect(calls).toHaveLength(0);
  });

  it('never lets concurrent requests overspend the daily budget', async () => {
    const { client, calls } = fakeClient(
      {
        [COUNT]: () => ({ body: { count: 500, total: 500 } }),
        [SEARCH]: () => ({ body: { items: items(10) } }),
      },
      undefined,
      2,
    );
    const deps = testDeps(client, { budget: new CreditBudget(30) });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => run(handlers.search, confirmed(10), deps, ip(`10.0.0.${i}`))),
    );
    expect(calls.filter((c) => c.path === '/v2/companies/search')).toHaveLength(3);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    const refused = results.filter((r) => r.status === 429);
    expect(refused).toHaveLength(9);
    expect((refused[0]?.body as { error: string }).error).toContain("Today's paid-search budget is used up");
    expect(deps.budget.remaining()).toBe(0);
  });

  it('throttles paid searches per client address', async () => {
    const { client } = fakeClient({
      [COUNT]: () => ({ body: { count: 5, total: 5 } }),
      [SEARCH]: () => ({ body: { items: items(3) } }),
    });
    const deps = testDeps(client, { paidSearchThrottle: new SlidingWindowLimiter(2, 60 * 60_000) });
    expect((await run(handlers.search, confirmed(), deps, ip('1.1.1.1'))).status).toBe(200);
    expect((await run(handlers.search, confirmed(), deps, ip('1.1.1.1'))).status).toBe(200);
    const third = await run(handlers.search, confirmed(), deps, ip('1.1.1.1'));
    expect(third).toEqual({ status: 429, body: { error: 'Too many paid searches from this address. Try again in 60 min.' } });
    expect((await run(handlers.search, confirmed(), deps, ip('2.2.2.2'))).status).toBe(200);
  });

  it('skips the paid call and returns the reservation when nothing matches', async () => {
    const { client, calls } = fakeClient({ [COUNT]: () => ({ body: { count: 0, total: 0 } }) });
    const deps = testDeps(client, { budget: new CreditBudget(10) });
    const result = await run(handlers.search, confirmed(10), deps);
    expect(result.body).toEqual({ items: [], matches: 0, credits: 0, skipped: true });
    expect(calls).toHaveLength(1);
    expect(deps.budget.remaining()).toBe(10);
  });

  it('refunds a 402 (not billed) but keeps the reservation after a 5xx (outcome unknown)', async () => {
    const declined = fakeClient({
      [COUNT]: () => ({ body: { count: 5, total: 5 } }),
      [SEARCH]: () => ({ status: 402, body: { title: 'Payment Required' } }),
    });
    const declinedDeps = testDeps(declined.client, { budget: new CreditBudget(10) });
    expect(await run(handlers.search, confirmed(5), declinedDeps)).toEqual({
      status: 402,
      body: { error: 'Not enough credits, or your plan does not include this request.' },
    });
    expect(declinedDeps.budget.remaining()).toBe(10);

    const crashed = fakeClient({
      [COUNT]: () => ({ body: { count: 5, total: 5 } }),
      [SEARCH]: () => ({ status: 500, body: { title: 'Server Error' } }),
    });
    const crashedDeps = testDeps(crashed.client, { budget: new CreditBudget(10) });
    expect((await run(handlers.search, confirmed(5), crashedDeps)).status).toBe(502);
    expect(crashedDeps.budget.remaining()).toBe(5);
    // A paid POST is never retried by the SDK, so one reservation is one attempt.
    expect(crashed.calls.filter((c) => c.path === '/v2/companies/search')).toHaveLength(1);
  });

  it('refuses unconfirmed or oversized requests before touching the budget or the API', async () => {
    const { client, calls } = fakeClient({});
    const deps = testDeps(client, { budget: new CreditBudget(10) });
    expect((await run(handlers.search, { filter: {}, pageSize: 5 }, deps)).status).toBe(400);
    expect((await run(handlers.search, { filter: {}, pageSize: 5, confirm: false }, deps)).status).toBe(400);
    expect((await run(handlers.search, { filter: {}, pageSize: 50, confirm: true }, deps)).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(deps.budget.remaining()).toBe(10);
  });
});

describe('reference data', () => {
  it('maps autocomplete results for each kind', async () => {
    const { client, calls } = fakeClient({
      'GET /v2/technologies/autocomplete': () => ({ body: { items: ['stripe', 'strikingly'] } }),
      'POST /v2/geo/countries': () => ({ body: { items: [{ code: 'DE', name: 'Germany' }] } }),
      'POST /v2/geo/states': () => ({ body: { items: [{ id: 4845, name: 'California', countryCode: 'US' }] } }),
    });
    const deps = testDeps(client);
    expect((await run(handlers.autocomplete, { kind: 'technologies', q: 'stri' }, deps)).body).toEqual({
      items: [
        { value: 'stripe', label: 'stripe' },
        { value: 'strikingly', label: 'strikingly' },
      ],
    });
    expect((await run(handlers.autocomplete, { kind: 'countries', q: 'ger' }, deps)).body).toEqual({
      items: [{ value: 'DE', label: 'Germany' }],
    });
    expect((await run(handlers.autocomplete, { kind: 'states', q: 'cali', countries: ['US'] }, deps)).body).toEqual({
      items: [{ value: 4845, label: 'California, United States' }],
    });
    expect(calls.at(-1)?.body).toEqual({ query: 'cali', pageSize: 10, countryCodes: ['US'] });
    expect((await run(handlers.autocomplete, { kind: 'people', q: 'x' }, deps)).status).toBe(400);
  });

  it('lists regions and industries', async () => {
    const { client } = fakeClient({
      'GET /v2/geo/regions': () => ({
        body: { items: [{ id: 'Europe/Western Europe', name: 'Western Europe', parentId: 'Europe', countryCodes: ['DE'] }] },
      }),
      'GET /v2/industries': () => ({ body: { items: [{ name: 'Software', naicsCodes: ['5112'] }] } }),
    });
    const deps = testDeps(client);
    expect((await run(handlers.regions, undefined, deps)).body).toEqual({
      items: [{ value: 'Europe/Western Europe', label: 'Western Europe', parent: 'Europe' }],
    });
    expect((await run(handlers.industries, undefined, deps)).body).toEqual({
      items: [{ name: 'Software', naicsCodes: ['5112'] }],
    });
  });
});

describe('unknown filter keys', () => {
  // An unknown key is rejected, never passed on or dropped, so the query is always the one the user built.
  const unknownKeys = [
    { industry: 'Software' },
    { country: ['US'], technologies: { all: ['stripe'], any: ['react'] } },
    { categories: { in: ['saas'], all: ['b2b'] } },
    { foundedYear: { min: 2015, from: 2010 } },
    { fundingAmount: { min: 1, currency: 'EUR' } },
    { workforceGrowth: { period: 'y1', department: 'sales', min: 0.1, minPercent: 10 } },
  ];
  const grid = { rows: { dimension: 'country', values: ['US'] }, columns: { dimension: 'employees', values: ['1-10'] } };
  const routes = [
    ['count', handlers.count, {}],
    ['grid', handlers.grid, grid],
    ['preview', handlers.preview, {}],
    ['search', handlers.search, { pageSize: 3, confirm: true }],
  ] as const;

  it.each(routes)('%s rejects them with a 400 before calling the API', async (_name, handler, extra) => {
    const { client, calls } = fakeClient({});
    for (const filter of unknownKeys) {
      const result = await run(handler, { filter, ...extra }, testDeps(client));
      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toMatch(/^filter/);
    }
    expect(calls).toHaveLength(0);
  });
});
