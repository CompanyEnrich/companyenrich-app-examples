import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/lib/cache';
import { DailyCreditLedger } from '../src/lib/credits';
import { COMPANY_CACHE_TTL_MS, type CompanyLookup } from '../src/lib/enrich';
import type { ApiRequest } from '../src/lib/http';
import { handlePlayground, type PlaygroundDeps, type PlaygroundResponse } from '../src/lib/playground';
import { RateLimiter } from '../src/lib/rate-limit';
import { companyFixture, companyHandlers, fakeApi, type FakeApi } from './fake-api';
import { apiCall, NOW, shippedConfig } from './helpers';

function request(body: unknown, headers: Record<string, string> = {}): ApiRequest {
  return { headers: new Headers({ 'content-type': 'application/json', ...headers }), body: new Response(JSON.stringify(body)).body, clientKey: '203.0.113.9' };
}

function deps(api: FakeApi, overrides: Partial<PlaygroundDeps> = {}): PlaygroundDeps {
  return {
    secret: undefined,
    secretRequired: false,
    limiter: new RateLimiter(100),
    loadConfig: shippedConfig,
    call: apiCall(api),
    companyCache: new TtlCache<CompanyLookup>({ ttlMs: COMPANY_CACHE_TTL_MS }),
    ledger: new DailyCreditLedger(100, () => NOW),
    now: () => NOW,
    ...overrides,
  };
}

const domains = ['acme.example', 'demo@gmail.com', 'beta.example', 'not a domain'];
const companies = { 'acme.example': companyFixture(), 'beta.example': companyFixture({ id: 'cmp-beta', domain: 'beta.example', employees: '11-50' }) };

describe('handlePlayground', () => {
  it('estimates for free, then runs enrichBatch only after a confirm that covers the estimate', async () => {
    const api = fakeApi(companyHandlers(companies));
    const shared = deps(api);

    const estimate = (await handlePlayground(request({ domains }), shared)).body as PlaygroundResponse;
    expect(api.calls).toHaveLength(0);
    expect(estimate).toMatchObject({ mode: 'estimate', credits: 6, creditsPerCompany: 3, expand: ['financial', 'technologies'] });
    expect(estimate.rows.map((row) => row.status)).toEqual(['to-enrich', 'free-mail', 'to-enrich', 'invalid']);

    const tooLow = await handlePlayground(request({ domains, confirm: true, maxCredits: 3 }), shared);
    expect(tooLow.status).toBe(409);
    expect(api.calls).toHaveLength(0);

    const result = (await handlePlayground(request({ domains, confirm: true, maxCredits: 6 }), shared)).body as PlaygroundResponse;
    expect(api.callsTo('POST /v2/companies/enrich/batch')).toHaveLength(1);
    expect(result).toMatchObject({ mode: 'result', credits: 6 });
    expect(result.rows[0]).toMatchObject({ status: 'found', source: 'api', tier: 'A', team: 'enterprise-na', company: { name: 'Acme Cloud' } });

    const again = (await handlePlayground(request({ domains }), shared)).body as PlaygroundResponse;
    expect(again.credits).toBe(0);
    expect(again.rows[0]).toMatchObject({ status: 'found', source: 'cache' });
  });

  it('never reaches a paid endpoint without a confirm that covers the cost', async () => {
    const api = fakeApi(companyHandlers(companies));
    expect((await handlePlayground(request({ domains, confirm: false, maxCredits: 1000 }), deps(api))).status).toBe(200);
    expect((await handlePlayground(request({ domains, confirm: true }), deps(api))).status).toBe(409);
    expect(api.calls).toHaveLength(0);
  });

  it('answers 502 with the API error when the run fails', async () => {
    const api = fakeApi({ 'POST /v2/companies/enrich/batch': () => ({ status: 401, body: { title: 'Unauthorized', status: 401 } }) });
    const response = await handlePlayground(request({ domains: ['acme.example'], confirm: true, maxCredits: 3 }), deps(api));
    expect(response).toEqual({ status: 502, body: { error: expect.stringContaining('rejected the API key (401)') } });
  });

  it('accepts at most 20 domains', async () => {
    const response = await handlePlayground(request({ domains: Array.from({ length: 21 }, (_, i) => `d${i}.example`) }), deps(fakeApi({})));
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toContain('domains');
  });

  it('refuses a run that would pass the daily credit cap', async () => {
    const api = fakeApi(companyHandlers(companies));
    const response = await handlePlayground(request({ domains, confirm: true, maxCredits: 6 }), deps(api, { ledger: new DailyCreditLedger(5, () => NOW) }));
    expect(response.status).toBe(402);
    expect(api.calls).toHaveLength(0);
  });

  it('refuses to spend without a secret in production', async () => {
    const api = fakeApi(companyHandlers(companies));
    const response = await handlePlayground(request({ domains, confirm: true, maxCredits: 6 }), deps(api, { secretRequired: true }));
    expect(response.status).toBe(503);
    expect(api.calls).toHaveLength(0);
  });

  it('requires the shared secret when one is configured', async () => {
    const response = await handlePlayground(request({ domains }), deps(fakeApi({}), { secret: 's3cret' }));
    expect(response.status).toBe(401);
  });
});
