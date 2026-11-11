import { AuthenticationError, ConnectionError, ServerError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import {
  enrichCompany,
  findLookalikes,
  findPeople,
  getWorkforce,
  lookupPersonByEmail,
} from '../src/lib/tools';
import { acmeRoutes, fakeApi, ok, problem, testContext, WORKFORCE } from './fakes';

describe('enrich_company', () => {
  it('requests the paid expansions, reserves their cost and returns a compact profile', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client);

    const outcome = await enrichCompany(ctx, { domain: 'https://www.Acme.example/pricing', includeFunding: true, includeTech: true });

    const [request] = api.calls('GET /v2/companies/enrich');
    expect(request?.query.get('domain')).toBe('acme.example');
    expect(request?.query.getAll('expand')).toEqual(['financial', 'technologies']);
    expect(ctx.budget.ledger).toEqual([{ tool: 'enrich_company', args: 'acme.example +financial +technologies', reserved: 3, estimated: 3 }]);

    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
    const { company, retrievedAt } = outcome.data;
    expect(retrievedAt).toBe('2026-11-11T09:00:00.000Z');
    expect(company.financial?.fundingStage).toBe('series_b');
    // Rounds are sorted newest first and the source URL is dropped.
    expect(company.financial?.fundingRounds?.[0]).toEqual({ date: '2025-06-15T00:00:00', type: 'Series B', amount: '40000000 USD', investors: 'Example Ventures' });
    expect(company.location).toEqual({ city: { name: 'Austin' }, state: { name: 'Texas' }, country: { code: 'US', name: 'United States' } });
    // Fields a brief does not need stay out of the model's context.
    expect(company).not.toHaveProperty('logoUrl');
    expect(company).not.toHaveProperty('socials');
    expect(ctx.calls).toHaveLength(1);
  });

  it('returns a not-found error, settles at 0 and records no call', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client);

    const outcome = await enrichCompany(ctx, { domain: 'unknown.example', includeFunding: true });

    expect(outcome).toEqual({ status: 'error', error: 'no company found for unknown.example (not charged)' });
    expect(ctx.budget.ledger[0]).toMatchObject({ reserved: 2, estimated: 0 });
    expect(ctx.calls).toHaveLength(0);
  });

  it('does not call the API when the budget refuses the reservation', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client, 2);

    const outcome = await enrichCompany(ctx, { domain: 'acme.example', includeFunding: true, includeTech: true });

    expect(outcome).toEqual({ status: 'error', error: 'budget exceeded: this call needs 3 credits, 2 remaining' });
    expect(api.calls('GET /v2/companies/enrich')).toHaveLength(0);
  });

  it('rejects an invalid domain without any request', async () => {
    const api = fakeApi(acmeRoutes());
    const outcome = await enrichCompany(testContext(api.client), { domain: 'not a domain' });
    expect(outcome.status).toBe('error');
    expect(api.requests).toHaveLength(0);
  });

  it('rethrows errors the agent cannot fix, such as a bad API key', async () => {
    const api = fakeApi(acmeRoutes({ 'GET /v2/companies/enrich': () => problem(401, 'Invalid API key') }));
    await expect(enrichCompany(testContext(api.client), { domain: 'acme.example' })).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('paid GET retries', () => {
  // Paid GETs are sent once, so one reservation always matches one request.
  // These clients keep the SDK default of 2 retries, so only the per-request override prevents them.

  it('sends a paid enrich once when the connection drops, instead of up to 3 times', async () => {
    const api = fakeApi(
      acmeRoutes({
        'GET /v2/companies/enrich': () => {
          throw new TypeError('socket hang up');
        },
      }),
      { maxRetries: 2 },
    );
    const ctx = testContext(api.client);

    await expect(enrichCompany(ctx, { domain: 'acme.example', includeFunding: true })).rejects.toBeInstanceOf(ConnectionError);

    expect(api.calls('GET /v2/companies/enrich')).toHaveLength(1);
    // The outcome is unknown, so the reservation stays and nothing is marked as settled.
    expect(ctx.budget.ledger).toEqual([{ tool: 'enrich_company', args: 'acme.example +financial', reserved: 2, estimated: null }]);
  });

  it('sends a paid workforce request once after a 5xx', async () => {
    const api = fakeApi(acmeRoutes({ 'GET /v2/companies/workforce': () => problem(503, 'Unavailable') }), { maxRetries: 2 });

    await expect(getWorkforce(testContext(api.client), { domain: 'acme.example' })).rejects.toBeInstanceOf(ServerError);
    expect(api.calls('GET /v2/companies/workforce')).toHaveLength(1);
  });

  it('retries a 429, which is not billed', async () => {
    let attempts = 0;
    const api = fakeApi(
      acmeRoutes({
        'GET /v2/companies/workforce': () =>
          ++attempts === 1 ? { ...problem(429, 'Too many requests'), headers: { 'retry-after': '0' } } : ok(WORKFORCE),
      }),
      { maxRetries: 2 },
    );
    const ctx = testContext(api.client);

    const outcome = await getWorkforce(ctx, { domain: 'acme.example' });

    expect(outcome.status).toBe('ok');
    expect(api.calls('GET /v2/companies/workforce')).toHaveLength(2);
    expect(ctx.budget.ledger[0]).toMatchObject({ reserved: 1, estimated: 1 });
  });
});

describe('get_workforce', () => {
  it('computes department shares and the 12-month change from history', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client);

    const outcome = await getWorkforce(ctx, { domain: 'acme.example' });

    if (outcome.status !== 'ok') throw new Error('expected ok');
    const { workforce } = outcome.data;
    expect(workforce.observedEmployeeCount).toBe(300);
    expect(Object.keys(workforce.departmentHeadcount)[0]).toBe('engineeringTechnical');
    expect(workforce.departmentHeadcount).not.toHaveProperty('design'); // zero headcount is dropped
    expect(workforce.departmentShare.engineeringTechnical).toBe(0.41);
    expect(workforce.change12m).toEqual({ fromDate: '2025-12-01', fromCount: 250, toDate: '2026-11-01', toCount: 300, pct: 0.2 });
    expect(workforce.departmentChange12m?.sales).toEqual({ from: 40, to: 60, pct: 0.5 });
    // Departments under 10 people at the start are too small for a meaningful growth rate.
    expect(workforce.departmentChange12m).not.toHaveProperty('cSuite');
    expect(ctx.budget.ledger[0]).toMatchObject({ tool: 'get_workforce', reserved: 1, estimated: 1 });
  });
});

describe('find_people', () => {
  it('counts for free, then searches only for as many people as matched, up to the limit', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client);

    const outcome = await findPeople(ctx, {
      domain: 'acme.example',
      seniority: ['c-suite', 'founder', 'vp'],
      excludeDepartment: ['sales', 'engineering-technical', 'marketing'],
      limit: 3,
    });

    const [count] = api.calls('POST /v2/people/search/count');
    const [search] = api.calls('POST /v2/people/search');
    expect(count?.body.filter).toEqual({
      domain: 'acme.example',
      seniority: ['c-suite', 'founder', 'vp'],
      department: { notIn: ['sales', 'engineering-technical', 'marketing'] },
    });
    expect(search?.body).toEqual({ filter: count?.body.filter, pageSize: 3 });
    expect(ctx.budget.ledger[0]).toMatchObject({ tool: 'find_people', reserved: 6, estimated: 6 });

    if (outcome.status !== 'ok') throw new Error('expected ok');
    const [ceo, cto] = outcome.data.people;
    expect(outcome.data.matched).toBe(30);
    expect(ceo?.experiences).toEqual([
      {
        position: 'Chief Executive Officer',
        seniority: 'c-suite',
        department: 'c-suite/executive',
        startDate: '2016-01-01',
        company: { name: 'Acme Cloud', domain: 'acme.example' },
      },
    ]);
    expect(ceo?.tenureYears).toBe(10.9);
    expect(cto?.tenureYears).toBe(0.6);
    expect(ceo).not.toHaveProperty('imageUrl');
  });

  it('skips the paid search when the free count is 0', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client);

    const outcome = await findPeople(ctx, { domain: 'acme.example', seniority: ['vp'], department: ['marketing'], limit: 2 });

    expect(outcome).toMatchObject({ status: 'ok', data: { matched: 0, people: [] } });
    expect(api.calls('POST /v2/people/search')).toHaveLength(0);
    expect(ctx.budget.ledger[0]).toMatchObject({ reserved: 0, estimated: 0 });
    expect(ctx.budget.ledger[0]?.args).toContain('paid search skipped');
  });

  it('caps the limit at 5 people', async () => {
    const api = fakeApi(acmeRoutes({ 'POST /v2/people/search/count': () => ({ status: 200, body: { count: 900, total: 900 } }) }));
    const ctx = testContext(api.client);

    await findPeople(ctx, { domain: 'acme.example', seniority: ['vp'], limit: 50 });

    expect(api.calls('POST /v2/people/search')[0]?.body.pageSize).toBe(5);
    expect(ctx.budget.ledger[0]?.reserved).toBe(10);
  });

  it('combines included and excluded departments in one rule', async () => {
    const api = fakeApi(acmeRoutes());
    await findPeople(testContext(api.client), {
      domain: 'acme.example',
      seniority: ['vp'],
      department: ['sales'],
      excludeDepartment: ['marketing'],
      limit: 1,
    });
    expect(api.calls('POST /v2/people/search/count')[0]?.body.filter.department).toEqual({ in: ['sales'], notIn: ['marketing'] });
  });
});

describe('find_lookalikes', () => {
  it('keeps the order the API returned, with each company score', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client);

    const outcome = await findLookalikes(ctx, { domain: 'acme.example', limit: 3 });

    expect(api.calls('POST /v2/companies/search/count')[0]?.body).toEqual({ lookalike: { domains: ['acme.example'] } });
    expect(api.calls('POST /v2/companies/search')[0]?.body).toEqual({ lookalike: { domains: ['acme.example'] }, pageSize: 3 });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.data.lookalikes.map((company) => [company.domain, company.score])).toEqual([
      ['beta.example', 0.81],
      ['gamma.example', 0.86],
    ]);
    // Reserved for 3, billed for the 2 that came back.
    expect(ctx.budget.ledger[0]).toMatchObject({ reserved: 15, estimated: 10 });
  });

  it('refuses a seed that is not in the dataset, using only the free autocomplete', async () => {
    const api = fakeApi(acmeRoutes());
    const outcome = await findLookalikes(testContext(api.client), { domain: 'unknown.example', limit: 3 });

    expect(outcome.status).toBe('error');
    expect(api.calls('POST /v2/companies/search/count')).toHaveLength(0);
    expect(api.calls('POST /v2/companies/search')).toHaveLength(0);
  });
});

describe('dry run', () => {
  it('reserves the same credits as a live run but never calls a paid endpoint', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client, 40, true);

    const results = [
      await enrichCompany(ctx, { domain: 'acme.example', includeFunding: true, includeTech: true }),
      await getWorkforce(ctx, { domain: 'acme.example' }),
      await findPeople(ctx, { domain: 'acme.example', seniority: ['c-suite'], limit: 3 }),
      await findLookalikes(ctx, { domain: 'acme.example', limit: 3 }),
      await lookupPersonByEmail(ctx, { email: 'someone@acme.example' }),
    ];

    expect(results.map((result) => result.status)).toEqual(['dry-run', 'dry-run', 'dry-run', 'dry-run', 'dry-run']);
    const paths = new Set(api.requests.map((request) => `${request.method} ${request.path}`));
    expect([...paths].sort()).toEqual([
      'GET /v2/companies/autocomplete',
      'POST /v2/companies/search/count',
      'POST /v2/people/search/count',
    ]);
    expect(ctx.budget.ledger.map((entry) => entry.reserved)).toEqual([3, 1, 6, 15, 5]);
    expect(ctx.budget.estimated).toBe(30);
  });
});
