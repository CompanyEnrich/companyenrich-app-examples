import { CompanyEnrich } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/lib/cache';
import { apiCaller } from '../src/lib/client';
import { Limiter } from '../src/lib/concurrency';
import { ConfigError } from '../src/lib/config';
import { COMPANY_CACHE_TTL_MS, CompanyLookups, type CompanyLookup } from '../src/lib/enrich';
import { rateLimitKey, type ApiRequest } from '../src/lib/http';
import { RateLimiter } from '../src/lib/rate-limit';
import { handleInbound, MAX_INBOUND_BODY_BYTES, type InboundDeps } from '../src/lib/webhook';
import { companyFixture, companyHandlers, fakeApi, type FakeApi } from './fake-api';
import { pipelineDeps, shippedConfig } from './helpers';

function request(body: unknown, headers: Record<string, string> = {}, clientKey = '203.0.113.7'): ApiRequest {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: new Response(text).body,
    clientKey,
  };
}

function deps(api: FakeApi, overrides: Partial<InboundDeps> = {}): InboundDeps {
  return {
    secret: undefined,
    secretRequired: false,
    limiter: new RateLimiter(100),
    loadConfig: shippedConfig,
    pipeline: pipelineDeps(api),
    ...overrides,
  };
}

const lead = { email: 'demo@acme.example', name: 'Demo', source: 'website' };

describe('handleInbound: authentication', () => {
  const api = () => fakeApi(companyHandlers({ 'acme.example': companyFixture() }));

  it('refuses to run unauthenticated in production unless explicitly allowed', async () => {
    const fake = api();
    const response = await handleInbound(request(lead), deps(fake, { secretRequired: true }));
    expect(response).toEqual({ status: 503, body: { error: expect.stringContaining('INBOUND_WEBHOOK_SECRET is not set') } });
    expect(fake.calls).toHaveLength(0);
    expect((await handleInbound(request(lead, { 'x-webhook-secret': 's3cret' }), deps(fake, { secretRequired: true, secret: 's3cret' }))).status).toBe(200);
  });

  it('accepts requests without a header when no secret is configured (development)', async () => {
    expect((await handleInbound(request(lead), deps(api()))).status).toBe(200);
  });

  it('rejects a missing or wrong secret before doing any work', async () => {
    const fake = api();
    const secured = deps(fake, { secret: 's3cret' });
    expect((await handleInbound(request(lead), secured)).status).toBe(401);
    expect((await handleInbound(request(lead, { 'x-webhook-secret': 'nope' }), secured)).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
    expect((await handleInbound(request(lead, { 'x-webhook-secret': 's3cret' }), secured)).status).toBe(200);
  });
});

describe('handleInbound: validation', () => {
  const api = fakeApi(companyHandlers({}));

  it.each([
    [{ name: 'No email' }, 400, 'email: Invalid input'],
    [{ email: 'not-an-email' }, 400, 'email: Invalid email address'],
    [{ email: 'demo@acme-.example' }, 400, 'not a valid company domain'],
    [{ email: 'demo@acme.example', name: 'x'.repeat(201) }, 400, 'name: Too big'],
    ['{"email": ', 400, 'not valid JSON'],
  ])('%j -> %i', async (body, status, message) => {
    const response = await handleInbound(request(body), deps(api));
    expect(response.status).toBe(status);
    expect((response.body as { error: string }).error).toContain(message);
  });

  it('requires a JSON content type', async () => {
    const response = await handleInbound(request(lead, { 'content-type': 'text/plain' }), deps(api));
    expect(response.status).toBe(415);
  });

  it('rejects bodies over the limit, even without a Content-Length header', async () => {
    const big = { ...lead, name: 'x'.repeat(MAX_INBOUND_BODY_BYTES) };
    expect((await handleInbound(request(big), deps(api))).status).toBe(413);
    expect((await handleInbound(request(lead, { 'content-length': String(MAX_INBOUND_BODY_BYTES + 1) }), deps(api))).status).toBe(413);
  });

  it('never calls the API for rejected input', () => {
    expect(api.calls).toHaveLength(0);
  });
});

describe('handleInbound: rate limit and errors', () => {
  it('limits requests per IP and says when to retry', async () => {
    const api = fakeApi(companyHandlers({}));
    const limited = deps(api, { limiter: new RateLimiter(2) });
    const free = { email: 'demo@gmail.com' };
    expect((await handleInbound(request(free), limited)).status).toBe(200);
    expect((await handleInbound(request(free), limited)).status).toBe(200);
    const third = await handleInbound(request(free), limited);
    expect(third.status).toBe(429);
    expect(third.headers?.['Retry-After']).toMatch(/^\d+$/);
    expect((await handleInbound(request(free, {}, '198.51.100.1'), limited)).status).toBe(200);
  });

  it('ignores X-Forwarded-For unless the proxy is trusted, and then uses the right-most hop', () => {
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.99, 203.0.113.7' });
    expect(rateLimitKey(headers, false)).toBe('all-clients');
    expect(rateLimitKey(headers, true)).toBe('203.0.113.7');
    expect(rateLimitKey(new Headers(), true)).toBe('unknown');
  });

  it('answers 502 with a one-line message when CompanyEnrich fails', async () => {
    const api = fakeApi({ 'GET /v2/companies/enrich': () => ({ status: 402, body: { title: 'Payment Required', status: 402 } }) });
    const response = await handleInbound(request(lead), deps(api));
    expect(response).toEqual({ status: 502, body: { error: expect.stringContaining('402') } });
  });

  it('includes credits a failed enrichment may still have used in the 502', async () => {
    const api = fakeApi({ 'GET /v2/companies/enrich': () => ({ status: 503, body: { title: 'Unavailable', status: 503 } }) });
    const response = await handleInbound(request(lead), deps(api));
    expect(response).toEqual({ status: 502, body: { error: expect.stringContaining('503'), uncertainCredits: 3 } });
  });

  it('explains a missing API key in one line, and still serves free-mail and cached leads', async () => {
    const api = fakeApi(companyHandlers({}));
    const companyCache = new TtlCache<CompanyLookup>({ ttlMs: COMPANY_CACHE_TTL_MS });
    // The client is built on first use, as in the app, so the missing key only matters for a cache miss.
    const noKey = deps(api);
    noKey.pipeline.companies = new CompanyLookups(apiCaller(() => new CompanyEnrich({ apiKey: '' }), new Limiter(4)), companyCache);
    const response = await handleInbound(request(lead), noKey);
    expect(response).toEqual({ status: 502, body: { error: expect.stringContaining('COMPANYENRICH_API_KEY is not set') } });
    expect((await handleInbound(request({ email: 'demo@gmail.com' }), noKey)).status).toBe(200);
    companyCache.set('cached.example', { status: 'not-found' });
    expect((await handleInbound(request({ email: 'demo@cached.example' }), noKey)).status).toBe(200);
  });

  it('answers 500 with the file and field when a config file is invalid', async () => {
    const api = fakeApi(companyHandlers({}));
    const response = await handleInbound(request(lead), deps(api, { loadConfig: () => { throw new ConfigError('config/routing.json is invalid: rules.0.team'); } }));
    expect(response).toEqual({ status: 500, body: { error: 'config/routing.json is invalid: rules.0.team' } });
  });

  it('returns the decision trace', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': companyFixture() }));
    const response = await handleInbound(request(lead), deps(api));
    expect(response.body).toMatchObject({ status: 'scored', decision: { tier: 'A', team: 'enterprise-na' }, lead: { email: 'demo@acme.example', name: 'Demo' } });
  });
});
