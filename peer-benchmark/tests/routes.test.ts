import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as autocomplete } from '@/app/api/autocomplete/route';
import { POST as benchmark } from '@/app/api/benchmark/route';
import { POST as suggest } from '@/app/api/suggest/route';
import { ACME, BETA, fakeApi } from './fixtures';

function post(body: unknown): Request {
  return new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) });
}

let api: ReturnType<typeof fakeApi>;

beforeEach(() => {
  api = fakeApi({
    workforce: { 'acme.com': ACME, 'beta.io': BETA },
    count: () => ({ count: 2, total: 2 }),
    search: () => ({ items: [{ id: 'c1', domain: 'eta.io', name: 'Eta', logoUrl: '' }], scores: { c1: 0.9 } }),
  });
  vi.stubGlobal('fetch', api.fetch);
  vi.stubEnv('COMPANYENRICH_API_KEY', 'test-key');
  // Each test starts with empty caches.
  delete (globalThis as { peerBenchmarkState?: unknown }).peerBenchmarkState;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/benchmark', () => {
  it('returns a free estimate without calling the API', async () => {
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'] }));
    expect(await response.json()).toEqual({
      mode: 'estimate',
      estimate: { companies: 2, cached: 0, credits: 2, budgetRemaining: 200 },
    });
    expect(api.calls).toHaveLength(0);
  });

  it('never spends without confirm: true, whatever maxCredits says', async () => {
    for (const body of [{ maxCredits: 10 }, { confirm: false, maxCredits: 10 }, { confirm: 'yes', maxCredits: 10 }]) {
      const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'], ...body }));
      expect((await response.json()).mode).toBe('estimate');
    }
    expect(api.calls).toHaveLength(0);
  });

  it('needs maxCredits with confirm', async () => {
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'], confirm: true }));
    expect(response.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });

  it('refuses to spend more than the confirmed amount', async () => {
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'], confirm: true, maxCredits: 1 }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/costs up to 2 credits, more than the 1 you confirmed/);
    expect(api.paidCalls()).toHaveLength(0);
  });

  it('runs once confirmed, then costs nothing for the next hour', async () => {
    const first = await benchmark(post({ company: 'acme.com', peers: ['beta.io'], confirm: true, maxCredits: 2 }));
    const body = await first.json();
    expect(first.status).toBe(200);
    expect(body).toMatchObject({ mode: 'result', creditsCharged: 2 });
    expect(body.insights.length).toBeGreaterThan(0);

    const estimate = await benchmark(post({ company: 'acme.com', peers: ['beta.io'] }));
    expect((await estimate.json()).estimate).toMatchObject({ credits: 0, budgetRemaining: 198 });
  });

  it('refuses a run the MAX_CREDITS budget cannot cover', async () => {
    vi.stubEnv('MAX_CREDITS', '1');
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'], confirm: true, maxCredits: 2 }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/only 1 more credits \(MAX_CREDITS\)/);
    expect(api.paidCalls()).toHaveLength(0);
  });

  it('explains a bad MAX_CREDITS', async () => {
    vi.stubEnv('MAX_CREDITS', 'lots');
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'] }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('MAX_CREDITS must be a whole number of credits, got "lots".');
  });

  it('rejects more than 8 peers before any call', async () => {
    const peers = Array.from({ length: 9 }, (_, index) => `peer${index}.com`);
    const response = await benchmark(post({ company: 'acme.com', peers, confirm: true, maxCredits: 100 }));
    expect(response.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await benchmark(new Request('http://localhost/api', { method: 'POST', body: 'nope' }));
    expect(response.status).toBe(400);
  });

  it('explains a missing key in one line', async () => {
    vi.stubEnv('COMPANYENRICH_API_KEY', '');
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'] }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'COMPANYENRICH_API_KEY is not set on the server. Get a key at https://companyenrich.com/dashboard.',
    });
  });

  it('reports credits spent before a failure, and charges them to the budget', async () => {
    vi.stubGlobal('fetch', fakeApi({ workforce: { 'acme.com': ACME }, workforceStatusByDomain: { 'beta.io': 401 } }).fetch);
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'], confirm: true, maxCredits: 2 }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ creditsCharged: 1 });
    const after = await benchmark(post({ company: 'acme.com', peers: ['beta.io'] }));
    expect((await after.json()).estimate).toMatchObject({ cached: 1, credits: 1, budgetRemaining: 199 });
  });

  it('explains a rejected key in one line', async () => {
    vi.stubGlobal('fetch', fakeApi({ failWith: 401 }).fetch);
    const response = await benchmark(post({ company: 'acme.com', peers: ['beta.io'], confirm: true, maxCredits: 2 }));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toMatch(/^CompanyEnrich rejected the API key/);
  });
});

describe('POST /api/suggest', () => {
  it('counts for free, then buys only after confirmation', async () => {
    const estimate = await suggest(post({ company: 'acme.com', count: 3 }));
    // Only 2 lookalikes exist, so the estimate is for 2.
    expect(await estimate.json()).toEqual({
      mode: 'estimate',
      estimate: { available: 2, requested: 3, pageSize: 2, credits: 10, cached: false, budgetRemaining: 200 },
    });
    expect(api.paidCalls()).toHaveLength(0);

    const unconfirmed = await suggest(post({ company: 'acme.com', count: 3, confirm: false, maxCredits: 10 }));
    expect((await unconfirmed.json()).mode).toBe('estimate');
    expect(api.paidCalls()).toHaveLength(0);

    const result = await suggest(post({ company: 'acme.com', count: 3, confirm: true, maxCredits: 10 }));
    expect(await result.json()).toMatchObject({ mode: 'result', creditsCharged: 5, peers: [{ domain: 'eta.io', score: 0.9 }] });
    // Asked for the 2 that exist, not the 3 requested, so the bill cannot pass the estimate.
    expect(api.paidCalls()[0]?.body).toMatchObject({ pageSize: 2 });
    // The 10 reserved credits were settled to the 5 actually charged.
    const after = await suggest(post({ company: 'acme.com', count: 1 }));
    expect((await after.json()).estimate.budgetRemaining).toBe(195);
  });

  it('refuses when the confirmed amount is below the estimate', async () => {
    const response = await suggest(post({ company: 'acme.com', count: 2, confirm: true, maxCredits: 5 }));
    expect(response.status).toBe(409);
    expect(api.paidCalls()).toHaveLength(0);
  });

  it('skips the paid search when the count is zero', async () => {
    vi.stubGlobal('fetch', fakeApi({ count: () => ({ count: 0, total: 0 }) }).fetch);
    const result = await suggest(post({ company: 'acme.com', count: 3, confirm: true, maxCredits: 15 }));
    expect(await result.json()).toEqual({ mode: 'result', peers: [], creditsCharged: 0, cached: false });
  });

  it('rejects more than 8 suggestions', async () => {
    const response = await suggest(post({ company: 'acme.com', count: 9, confirm: true, maxCredits: 45 }));
    expect(response.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });
});

describe('GET /api/autocomplete', () => {
  it('returns nothing for an empty query without calling the API', async () => {
    const response = await autocomplete(new Request('http://localhost/api/autocomplete?q='));
    expect(await response.json()).toEqual({ items: [] });
    expect(api.calls).toHaveLength(0);
  });

  it('rejects very long queries', async () => {
    const response = await autocomplete(new Request(`http://localhost/api/autocomplete?q=${'a'.repeat(101)}`));
    expect(response.status).toBe(400);
  });
});
