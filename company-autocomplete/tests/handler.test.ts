import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardedFor } from '../src/server/client-ip';
import { createCompanyHandler, type CompanyHandlerOptions, type RequestContext } from '../src/server/handler';
import type { EnrichResponse, ErrorResponse, SuggestResponse } from '../src/shared/types';
import { createFakeApi, STRIPE, type FakeApiRoutes, type Reply } from './fake-api';

function setup(options: CompanyHandlerOptions = {}, routes: FakeApiRoutes = {}) {
  const api = createFakeApi(routes);
  let time = 0;
  const onError = vi.fn();
  const handler = createCompanyHandler({ apiKey: 'test-key', fetch: api.fetch, now: () => time, onError, ...options });
  const get = (query: string, context?: RequestContext, init?: RequestInit) =>
    handler(new Request(`http://localhost/api/company?${query}`, init), context);
  return { api, get, onError, advance: (ms: number) => (time += ms) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('autocomplete (?q=)', () => {
  it('returns only domain, name and logo for each suggestion', async () => {
    const { get } = setup();
    const response = await get('q=stri');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual<SuggestResponse>({
      items: [
        { domain: 'stripe.com', name: 'Stripe', logoUrl: STRIPE.logoUrl },
        { domain: 'stringee.com', name: 'Stringee', logoUrl: 'https://api.companyenrich.com/companies/logo/b' },
        { domain: 'strike.me', name: 'strike.me', logoUrl: null },
      ],
    });
  });

  it('normalizes pasted URLs, spaces and punctuation before calling the API', async () => {
    const { api, get } = setup();
    await get(`q=${encodeURIComponent('https://www.Stripe.com/pricing')}`);
    await get(`q=${encodeURIComponent(' open ai ')}`);
    await get(`q=${encodeURIComponent('<stri>"\';')}`);
    expect(api.callsTo('autocomplete').map((url) => url.searchParams.get('query'))).toEqual(['stripe.com', 'openai', 'stri']);
  });

  it('answers queries under two characters without calling the API', async () => {
    const { api, get } = setup();
    const response = await get('q=s');
    expect(await response.json()).toEqual({ items: [] });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects queries over 100 characters', async () => {
    const { api, get } = setup();
    const response = await get(`q=${'a'.repeat(101)}`);
    expect(response.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });

  it('serves repeated queries from the cache until the TTL passes', async () => {
    const { api, get, advance } = setup({ cacheTtlMs: 60_000 });
    expect((await get('q=stri')).headers.get('x-cache')).toBe('miss');
    expect((await get('q=STRI%20')).headers.get('x-cache')).toBe('hit');
    expect(api.callsTo('autocomplete')).toHaveLength(1);

    advance(60_001);
    expect((await get('q=stri')).headers.get('x-cache')).toBe('miss');
    expect(api.callsTo('autocomplete')).toHaveLength(2);
  });
});

describe('enrichment (?domain=)', () => {
  it('returns the whitelisted profile and never the full payload or the key', async () => {
    const { get } = setup();
    const response = await get('domain=stripe.com');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual<EnrichResponse>({
      company: {
        id: STRIPE.id,
        domain: 'stripe.com',
        name: 'Stripe',
        logoUrl: STRIPE.logoUrl,
        industry: 'Financial Services',
        employees: '5K-10K',
        revenue: 'over-1b',
        foundedYear: 2010,
        country: { code: 'US', name: 'United States' },
        state: 'California',
        city: 'South San Francisco',
        linkedinUrl: 'https://www.linkedin.com/company/stripe',
      },
      credits: 1,
      cached: false,
    });
    for (const leaked of ['description', 'financial', 'technologies', 'Oyster Point', 'test-key']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('normalizes a pasted URL to its domain', async () => {
    const { api, get } = setup();
    const response = await get(`domain=${encodeURIComponent('https://www.stripe.com/pricing')}`);
    expect(response.status).toBe(200);
    expect(api.callsTo('enrich')[0]?.searchParams.get('domain')).toBe('stripe.com');
  });

  it('charges once: later lookups of the same company come from the cache', async () => {
    const { api, get } = setup();
    const first = (await (await get('domain=stripe.com')).json()) as EnrichResponse;
    const second = await get(`domain=${encodeURIComponent('https://stripe.com/')}`);
    expect(first).toMatchObject({ credits: 1, cached: false });
    expect(await second.json()).toMatchObject({ credits: 0, cached: true });
    expect(second.headers.get('x-cache')).toBe('hit');
    expect(api.callsTo('enrich')).toHaveLength(1);
  });

  it('shares one API call between concurrent lookups of the same domain', async () => {
    const { api, get } = setup();
    const responses = await Promise.all([get('domain=stripe.com'), get('domain=stripe.com'), get('domain=www.stripe.com')]);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as EnrichResponse[];
    expect(bodies.map((body) => body.credits)).toEqual([1, 0, 0]);
    expect(api.callsTo('enrich')).toHaveLength(1);
  });

  it('returns 404 for an unknown company and caches the miss', async () => {
    const { api, get } = setup();
    const response = await get('domain=unknown-company.example');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual<ErrorResponse>({
      error: { code: 'not_found', message: 'No company data found for unknown-company.example.' },
    });
    await get('domain=unknown-company.example');
    expect(api.callsTo('enrich')).toHaveLength(1);
  });

  it('rejects input that is not a domain without calling the API', async () => {
    const { api, get } = setup();
    const response = await get('domain=not%20a%20domain');
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorResponse).error.code).toBe('invalid_request');
    expect(api.calls).toHaveLength(0);
  });
});

// Every domain is a known company here, so each fresh lookup is billable.
const everyDomainFound: FakeApiRoutes = { enrich: (domain) => ({ body: { ...STRIPE, domain, name: domain } }) };

describe('client identity', () => {
  const oneCredit = { creditsPerClient: { limit: 1, windowMs: 60_000 } };

  it('ignores X-Forwarded-For by default, so forging it cannot dodge the limits', async () => {
    const { get } = setup(oneCredit, everyDomainFound);
    const forged = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });
    expect((await get('domain=a.example', undefined, forged('198.51.100.1'))).status).toBe(200);
    expect((await get('domain=b.example', undefined, forged('198.51.100.2'))).status).toBe(429);
  });

  it('uses the right-most untrusted hop when told how many proxies to trust', async () => {
    const { get } = setup({ ...oneCredit, clientIp: forwardedFor(1) }, everyDomainFound);
    // The client prepends whatever it likes; the proxy appends the real address.
    const via = (forged: string, real: string) => ({ headers: { 'x-forwarded-for': `${forged}, ${real}` } });
    expect((await get('domain=a.example', undefined, via('1.1.1.1', '203.0.113.7'))).status).toBe(200);
    expect((await get('domain=b.example', undefined, via('2.2.2.2', '203.0.113.7'))).status).toBe(429);
    expect((await get('domain=b.example', undefined, via('2.2.2.2', '203.0.113.8'))).status).toBe(200);
  });

  it('prefers the connection IP an adapter passes in', async () => {
    const { get } = setup({ ...oneCredit, clientIp: forwardedFor(1) }, everyDomainFound);
    const forged = { headers: { 'x-forwarded-for': '198.51.100.1' } };
    expect((await get('domain=a.example', { clientIp: '203.0.113.1' }, forged)).status).toBe(200);
    expect((await get('domain=b.example', { clientIp: '203.0.113.1' }, forged)).status).toBe(429);
  });
});

describe('throttle', () => {
  it('counts every request per client, including cache hits and misses', async () => {
    const { get } = setup({ throttle: { limit: 3, windowMs: 60_000 } });
    const alice = { clientIp: '203.0.113.1' };
    await get('q=stri', alice);
    await get('q=stri', alice); // cache hit
    await get('domain=unknown.example', alice); // free 404

    const limited = await get('q=stri', alice);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await get('q=stri', { clientIp: '203.0.113.2' })).status).toBe(200);
  });
});

describe('credit reservations', () => {
  it('limits fresh enrichments per client, with Retry-After', async () => {
    const { api, get } = setup({ creditsPerClient: { limit: 2, windowMs: 60_000 } }, everyDomainFound);
    const alice = { clientIp: '203.0.113.1' };
    expect((await get('domain=a.example', alice)).status).toBe(200);
    expect((await get('domain=b.example', alice)).status).toBe(200);

    const limited = await get('domain=c.example', alice);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(((await limited.json()) as ErrorResponse).error.code).toBe('rate_limited');
    expect(api.callsTo('enrich')).toHaveLength(2);
  });

  it('still serves cached companies and other clients while one client is limited', async () => {
    const { get } = setup({ creditsPerClient: { limit: 1, windowMs: 60_000 } }, everyDomainFound);
    const alice = { clientIp: '203.0.113.1' };
    await get('domain=stripe.com', alice);
    expect((await get('domain=a.example', alice)).status).toBe(429);
    expect((await get('domain=stripe.com', alice)).status).toBe(200);
    expect((await get('domain=a.example', { clientIp: '203.0.113.2' })).status).toBe(200);
  });

  it('resets after the window', async () => {
    const { get, advance } = setup({ creditsPerClient: { limit: 1, windowMs: 60_000 } }, everyDomainFound);
    await get('domain=a.example', { clientIp: '203.0.113.1' });
    expect((await get('domain=b.example', { clientIp: '203.0.113.1' })).status).toBe(429);
    advance(60_000);
    expect((await get('domain=b.example', { clientIp: '203.0.113.1' })).status).toBe(200);
  });

  it('gives the reservation back when nothing was found', async () => {
    const { get } = setup({ creditsPerClient: { limit: 2, windowMs: 60_000 }, creditBudget: { limit: 2, windowMs: 86_400_000 } });
    const alice = { clientIp: '203.0.113.1' };
    for (let i = 0; i < 10; i += 1) {
      expect((await get(`domain=unknown-${i}.example`, alice)).status).toBe(404);
    }
    expect((await get('domain=stripe.com', alice)).status).toBe(200);
  });

  it('gives the reservation back when the API refused before billing, but not after a server error', async () => {
    const outcomes: Record<string, Reply> = {
      'refused.example': { status: 402, body: { title: 'Payment Required' } },
      'invalid.example': { status: 422, body: { title: 'Unprocessable Entity' } },
      'broken.example': { status: 500, body: { title: 'Internal Server Error' } },
    };
    const { get } = setup(
      { creditsPerClient: { limit: 1, windowMs: 60_000 } },
      { enrich: (domain) => outcomes[domain] ?? { body: { ...STRIPE, domain } } },
    );
    const alice = { clientIp: '203.0.113.1' };
    expect((await get('domain=refused.example', alice)).status).toBe(503);
    expect((await get('domain=invalid.example', alice)).status).toBe(400);
    // A 500 may have been billed, so its credit stays reserved.
    expect((await get('domain=broken.example', alice)).status).toBe(502);
    expect((await get('domain=stripe.com', alice)).status).toBe(429);
  });

  it('caps fresh enrichments across all clients with a budget, reported once', async () => {
    const { api, get, onError } = setup({ creditBudget: { limit: 2, windowMs: 86_400_000 } }, everyDomainFound);
    await get('domain=stripe.com', { clientIp: '203.0.113.1' });
    await get('domain=a.example', { clientIp: '203.0.113.2' });

    const refused = await get('domain=b.example', { clientIp: '203.0.113.3' });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as ErrorResponse).error.code).toBe('budget_exhausted');
    expect(refused.headers.get('retry-after')).toBe('86400');
    expect((await get('domain=c.example', { clientIp: '203.0.113.4' })).status).toBe(503);
    expect(onError).toHaveBeenCalledOnce();

    expect((await get('domain=stripe.com', { clientIp: '203.0.113.5' })).status).toBe(200);
    expect(api.callsTo('enrich')).toHaveLength(2);
  });

  it('does not let a budget refusal use up the client allowance', async () => {
    const { get, advance } = setup(
      { creditsPerClient: { limit: 1, windowMs: 3_600_000 }, creditBudget: { limit: 1, windowMs: 60_000 } },
      everyDomainFound,
    );
    await get('domain=a.example', { clientIp: '203.0.113.1' });
    expect((await get('domain=b.example', { clientIp: '203.0.113.2' })).status).toBe(503);
    advance(60_000);
    expect((await get('domain=b.example', { clientIp: '203.0.113.2' })).status).toBe(200);
  });
});

describe('error mapping', () => {
  // `retry-after: 0` makes any automatic SDK retry instant.
  const failWith = (status: number) => () => ({
    status,
    body: { title: 'Upstream detail that must not leak', status },
    headers: { 'retry-after': '0' },
  });

  it.each([
    [401, 503, 'not_configured'],
    [403, 503, 'not_configured'],
    [402, 503, 'unavailable'],
    [422, 400, 'invalid_request'],
    [500, 502, 'upstream_error'],
    [429, 429, 'rate_limited'],
  ])('maps an upstream %i to %i %s', async (upstream, status, code) => {
    const { get, onError } = setup({}, { enrich: failWith(upstream) });
    const response = await get('domain=stripe.com');
    const text = await response.text();
    expect(response.status).toBe(status);
    expect((JSON.parse(text) as ErrorResponse).error.code).toBe(code);
    expect(text).not.toContain('Upstream detail');
    // Busy upstreams are expected; everything else is reported for the operator.
    expect(onError).toHaveBeenCalledTimes(upstream === 429 ? 0 : 1);
  });

  it('never retries a paid enrichment, since a failed attempt may already be billed', async () => {
    const { api, get } = setup({}, { enrich: failWith(500) });
    expect((await get('domain=stripe.com')).status).toBe(502);
    expect(api.callsTo('enrich')).toHaveLength(1);
  });

  it('does not cache failures', async () => {
    let failures = 1;
    const { api, get } = setup({}, {
      enrich: () => (failures-- > 0 ? { status: 402, body: { title: 'Payment Required' } } : { body: STRIPE }),
    });
    expect((await get('domain=stripe.com')).status).toBe(503);
    expect((await get('domain=stripe.com')).status).toBe(200);
    expect(api.callsTo('enrich')).toHaveLength(2);
  });

  it('answers 503 when no API key is configured, without throwing at creation', async () => {
    vi.stubEnv('COMPANYENRICH_API_KEY', '');
    const onError = vi.fn();
    const handler = createCompanyHandler({ onError });
    const response = await handler(new Request('http://localhost/api/company?q=stripe'));
    expect(response.status).toBe(503);
    expect(((await response.json()) as ErrorResponse).error.code).toBe('not_configured');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects other methods and ambiguous requests', async () => {
    const { get } = setup();
    expect((await get('q=stri', undefined, { method: 'POST' })).status).toBe(405);
    expect((await get('q=stri&domain=stripe.com')).status).toBe(400);
    expect((await get('')).status).toBe(400);
  });
});
