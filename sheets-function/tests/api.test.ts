import { describe, expect, it } from 'vitest';
import { problem, setup } from './helpers.js';

describe('requests', () => {
  it('uses Bearer auth with the key from user properties', () => {
    const { script, urlFetch } = setup({ apiKey: 'secret-123' });
    script.COMPANYENRICH('acme.example', 'name');
    const [request] = urlFetch.requests;
    expect(request?.url).toBe('https://api.companyenrich.com/v2/companies/enrich?domain=acme.example&waitForEnrichment=true');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer secret-123', Accept: 'application/json' });
  });

  it('explains how to add a missing key, without calling the API', () => {
    const { script, urlFetch } = setup({ apiKey: null });
    expect(() => script.COMPANYENRICH('acme.example', 'name')).toThrow(
      'No CompanyEnrich API key. Use the CompanyEnrich menu > Set API key.',
    );
    expect(urlFetch.requests).toHaveLength(0);
  });
});

describe('error messages', () => {
  const enrichFails = (reply: ReturnType<typeof problem>) =>
    setup({ overrides: { '/companies/enrich': () => reply } });

  it.each([
    [401, 'CompanyEnrich rejected the API key (401). Set a valid key with CompanyEnrich > Set API key.'],
    [402, 'Not enough CompanyEnrich credits (402). Top up at https://companyenrich.com/dashboard.'],
    [403, 'Your CompanyEnrich plan does not include this feature (403).'],
  ])('HTTP %i', (status, message) => {
    const { script } = enrichFails(problem(status, 'detail from the API'));
    expect(() => script.COMPANYENRICH('acme.example', 'name')).toThrow(message);
  });

  it('includes field errors for validation failures', () => {
    const { script } = setup({
      overrides: {
        '/companies/search/count': () => ({
          status: 422,
          body: { title: 'Validation failed', errors: { 'filter.country': ['Unknown country code.'] } },
        }),
      },
    });
    expect(() => script.COMPANYENRICH_COUNT('XX', '', '')).toThrow(
      'CompanyEnrich rejected the request (422). Validation failed filter.country: Unknown country code.',
    );
  });

  it('retries a rate limit, honoring Retry-After, then succeeds', () => {
    let calls = 0;
    const { script, urlFetch, sleeps } = setup({
      overrides: {
        '/companies/enrich/batch': (request) => {
          calls++;
          if (calls === 1) return problem(429, 'Slow down', { 'retry-after': '3' });
          return { body: { items: request.body.domains.map((domain: string) => ({ domain, status: 'not-found' })) } };
        },
      },
    });
    expect(script.COMPANYENRICH([['a.example'], ['b.example']], 'name')).toEqual([['Not found'], ['Not found']]);
    expect(urlFetch.requests).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('waits for the rate-limit window when there is no Retry-After, capped at 8 seconds', () => {
    let calls = 0;
    const { script, sleeps } = setup({
      overrides: {
        '/companies/search/count': () =>
          ++calls === 1
            ? problem(429, 'Slow down', { 'X-RateLimit-Window': '00:00:04.5' })
            : calls === 2
              ? problem(429, 'Slow down', { 'x-ratelimit-window': '00:00:59.9' })
              : { body: { count: 1, total: 1 } },
      },
    });
    expect(script.COMPANYENRICH_COUNT('US', '', '')).toBe(1);
    expect(sleeps).toEqual([4500, 8000]);
  });

  it('gives up after two retries with a readable 429 message', () => {
    const { script, urlFetch, sleeps } = enrichFails(problem(429, 'Slow down'));
    expect(() => script.COMPANYENRICH('acme.example', 'name')).toThrow(
      'CompanyEnrich rate limit reached (429). Wait a minute and try again.',
    );
    expect(urlFetch.requests).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('retries server errors on free calls but never on paid calls', () => {
    const count = setup({ overrides: { '/companies/search/count': () => problem(503, 'Down') } });
    expect(() => count.script.COMPANYENRICH_COUNT('US', '', '')).toThrow('CompanyEnrich is having trouble (HTTP 503)');
    expect(count.urlFetch.requests).toHaveLength(3);

    const batch = setup({ overrides: { '/companies/enrich/batch': () => problem(502, 'Bad gateway') } });
    expect(() => batch.script.COMPANYENRICH([['a.example'], ['b.example']], 'name')).toThrow('HTTP 502');
    expect(batch.urlFetch.requests).toHaveLength(1); // the first attempt may already have been charged

    const enrich = setup({ overrides: { '/companies/enrich': () => problem(500, 'Oops') } });
    expect(() => enrich.script.COMPANYENRICH('acme.example', 'name')).toThrow('HTTP 500');
    expect(enrich.urlFetch.requests).toHaveLength(1); // a paid GET is not repeated either
  });

  it('reports network failures', () => {
    const { script } = setup({
      overrides: {
        '/companies/enrich': () => {
          throw new Error('Address unavailable: https://api.companyenrich.com');
        },
      },
    });
    expect(() => script.COMPANYENRICH('acme.example', 'name')).toThrow(
      'Could not reach CompanyEnrich: Address unavailable',
    );
  });

  it('treats a 404 from enrich as "Not found", not an error', () => {
    const { script } = enrichFails(problem(404, 'No company'));
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Not found');
  });
});
