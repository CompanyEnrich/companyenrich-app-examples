import { describe, expect, it } from 'vitest';
import { CompanyLookup } from '../src/lib/adapters/company-lookup.ts';
import { createLimiter } from '../src/lib/concurrency.ts';
import { fakeCompanyEnrich, jsonResponse, type RecordedRequest } from './fakes.ts';
import { stripe } from './fixtures.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function respond(request: RecordedRequest): Response {
  switch (request.query.get('domain')) {
    case 'stripe.com':
      return jsonResponse(stripe);
    case 'broken.example':
      return jsonResponse({ title: 'Server error' }, 500);
    case 'invalid.example':
      return jsonResponse({ title: 'Bad Request', detail: 'Invalid domain' }, 400);
    case 'offline.example':
      throw new TypeError('fetch failed');
    default:
      return jsonResponse({ title: 'Not Found' }, 404);
  }
}

/** The fake client keeps the SDK's default retries (2), as a real client would. */
function setup(maxCredits = 10, handler: (request: RecordedRequest) => Response | Promise<Response> = respond) {
  const ce = fakeCompanyEnrich({ 'GET /v2/companies/enrich': handler });
  return { ...ce, lookup: new CompanyLookup(ce.client, { maxCredits, rateLimitDelayMs: 0 }) };
}

describe('CompanyLookup', () => {
  it('returns a compact record with the fields the questions need', async () => {
    const { lookup } = setup();
    expect(JSON.parse(await lookup.lookup('stripe.com'))).toEqual({
      found: true,
      name: 'Stripe',
      domain: 'stripe.com',
      type: 'private',
      foundedYear: 2010,
      employees: 'over-10K',
      revenue: 'over-1b',
      industry: 'Finance',
      industries: ['Finance/Credit Cards & Transaction Processing'],
      categories: ['b2b', 'service-provider'],
      headquarters: { country: { code: 'US', name: 'United States' }, state: 'California', city: 'San Francisco' },
      financial: {
        totalFundingUsd: 8805247725,
        fundingStage: 'secondary_market',
        fundingDate: '2026-03-09T00:00:00',
      },
      updatedAt: stripe.updatedAt,
    });
  });

  it('caches by normalized domain and shares one request between concurrent calls', async () => {
    const { lookup, requests } = setup();
    const results = await Promise.all([
      lookup.lookup('stripe.com'),
      lookup.lookup('https://www.Stripe.com/'),
      lookup.lookup('stripe.com'),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(requests).toHaveLength(1);
    expect(lookup.apiCalls).toBe(1);
    expect(lookup.creditsSpent).toBe(2);
  });

  it('caches a miss without charging for it', async () => {
    const { lookup, requests } = setup();
    expect(JSON.parse(await lookup.lookup('nothing.example'))).toEqual({ found: false, domain: 'nothing.example' });
    await lookup.lookup('nothing.example');
    expect(requests).toHaveLength(1);
    expect(lookup.creditsSpent).toBe(0);
    expect(lookup.creditsUncertain).toBe(0);
  });

  it('releases the reservation when the API refuses the request (4xx)', async () => {
    const { lookup, requests } = setup();
    await expect(lookup.lookup('invalid.example')).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(lookup.creditsSpent + lookup.creditsUncertain).toBe(0);
  });

  it('rejects input that is not a domain without calling the API', async () => {
    const { lookup, requests } = setup();
    await expect(lookup.lookup('Stripe')).rejects.toThrow('is not a domain');
    expect(requests).toHaveLength(0);
  });
});

describe('CompanyLookup under the credit cap, with the SDK default retries', () => {
  it('sends a paid request once after a 5xx and keeps its credits counted as possibly spent', async () => {
    const { lookup, requests } = setup();
    await expect(lookup.lookup('broken.example')).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(lookup.creditsUncertain).toBe(2);
    expect(lookup.fatal).toBeNull();
  });

  it('sends a paid request once after a lost connection', async () => {
    const { lookup, requests } = setup();
    await expect(lookup.lookup('offline.example')).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(lookup.creditsUncertain).toBe(2);
  });

  it('never lets failed attempts exceed the budget', async () => {
    const { lookup, requests } = setup(2);
    await expect(lookup.lookup('broken.example')).rejects.toThrow();
    await expect(lookup.lookup('broken.example')).rejects.toThrow('The credit budget of 2 is used up');
    await expect(lookup.lookup('stripe.com')).rejects.toThrow('The credit budget of 2 is used up');
    expect(requests).toHaveLength(1);
  });

  it('refuses new lookups once the budget is used, but still serves the cache', async () => {
    const { lookup, requests } = setup(2);
    await lookup.lookup('stripe.com');
    await expect(lookup.lookup('another.example')).rejects.toThrow('The credit budget of 2 is used up');
    await expect(lookup.lookup('stripe.com')).resolves.toContain('Stripe');
    expect(requests).toHaveLength(1);
  });

  it('retries a 429 itself, since a rate-limited request is not charged', async () => {
    let calls = 0;
    const { lookup, requests } = setup(10, () => (++calls === 1 ? jsonResponse({ title: 'Too Many Requests' }, 429) : jsonResponse(stripe)));
    await expect(lookup.lookup('stripe.com')).resolves.toContain('Stripe');
    expect(requests).toHaveLength(2);
    expect(lookup.creditsSpent).toBe(2);
    expect(lookup.creditsUncertain).toBe(0);
  });

  it('stops after two 429 retries and releases the reservation', async () => {
    const { lookup, requests } = setup(10, () => jsonResponse({ title: 'Too Many Requests' }, 429));
    await expect(lookup.lookup('stripe.com')).rejects.toThrow();
    expect(requests).toHaveLength(3);
    expect(lookup.creditsSpent + lookup.creditsUncertain).toBe(0);
  });
});

describe('createLimiter', () => {
  it('never runs more than the limit at once, even when tasks start more tasks', async () => {
    const limit = createLimiter(4);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(2);
      active -= 1;
    };
    await Promise.all(Array.from({ length: 4 }, () => Promise.all([limit(task), limit(task), limit(task)])));
    expect(peak).toBe(4);
  });
});
