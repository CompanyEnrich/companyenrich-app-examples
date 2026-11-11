import { describe, expect, it } from 'vitest';
import { FakeCache } from '../harness/fakes.js';
import { setup } from './helpers.js';

describe('COMPANYENRICH', () => {
  it('returns one field with a single GET /v2/companies/enrich', () => {
    const { script, urlFetch } = setup();
    expect(script.COMPANYENRICH('https://www.acme.example/about', 'name')).toBe('Acme');
    expect(urlFetch.requests).toHaveLength(1);
    const [request] = urlFetch.to('/companies/enrich');
    expect(request?.method).toBe('GET');
    expect(request?.query.get('domain')).toBe('acme.example');
    expect(request?.query.get('waitForEnrichment')).toBe('true');
  });

  it('never fetches the same domain twice, whatever field is asked for', () => {
    const { script, urlFetch } = setup();
    script.COMPANYENRICH('acme.example', 'name');
    expect(script.COMPANYENRICH('ACME.example', 'employees')).toBe('1K-5K');
    expect(script.COMPANYENRICH('acme.example', 'location.country.name')).toBe('United States');
    expect(urlFetch.requests).toHaveLength(1);
  });

  it('serves from document properties after CacheService has expired', () => {
    const first = setup();
    first.script.COMPANYENRICH('acme.example', 'name');

    // Same spreadsheet (document properties), empty CacheService: like reopening the sheet hours later.
    const reopened = setup({ documentProperties: first.documentProperties, cache: new FakeCache() });
    expect(reopened.script.COMPANYENRICH('acme.example', 'industry')).toBe('Manufacturing');
    expect(reopened.urlFetch.requests).toHaveLength(0);
    expect(reopened.cache.get('ce:company:acme.example')).not.toBeNull(); // warmed again
  });

  it('shows "Not found" for unknown domains and caches that answer', () => {
    const { script, urlFetch, documentProperties } = setup();
    expect(script.COMPANYENRICH('unknown.example', 'name')).toBe('Not found');
    expect(script.COMPANYENRICH('unknown.example', 'name')).toBe('Not found');
    expect(urlFetch.requests).toHaveLength(1);
    expect(documentProperties.getKeys().filter((key) => key.startsWith('ce:company:'))).toEqual([]); // not kept forever
  });

  it('handles blanks and invalid values without calling the API', () => {
    const { script, urlFetch } = setup();
    expect(script.COMPANYENRICH('', 'name')).toBe('');
    expect(script.COMPANYENRICH('not a domain', 'name')).toBe('Invalid domain');
    expect(urlFetch.requests).toHaveLength(0);
  });

  it('rejects an unknown field before spending anything', () => {
    const { script, urlFetch } = setup();
    expect(() => script.COMPANYENRICH('acme.example', 'headcount')).toThrow('Unknown field "headcount"');
    expect(urlFetch.requests).toHaveLength(0);
  });

  it('turns a range into a column, using one batch call for the new domains', () => {
    const { script, urlFetch } = setup();
    const range = [['acme.example'], [''], ['globex.example'], ['unknown.example'], ['acme.example'], ['nope']];
    expect(script.COMPANYENRICH(range, 'name')).toEqual([
      ['Acme'],
      [''],
      ['Globex'],
      ['Not found'],
      ['Acme'],
      ['Invalid domain'],
    ]);
    const batches = urlFetch.to('/companies/enrich/batch');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.body).toEqual({
      domains: ['acme.example', 'globex.example', 'unknown.example'],
      waitForEnrichment: false, // keeps a range inside the 30-second custom function limit
    });
  });

  it('sends only uncached domains, 50 per batch call', () => {
    const { script, urlFetch } = setup();
    script.COMPANYENRICH('acme.example', 'name');
    const domains = Array.from({ length: 120 }, (_, i) => [`company-${i}.example`]);
    script.COMPANYENRICH([['acme.example'], ...domains], 'name');
    const sizes = urlFetch.to('/companies/enrich/batch').map((request) => request.body.domains.length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(urlFetch.to('/companies/enrich/batch')[0]?.body.domains).not.toContain('acme.example');
  });

  it('shows pending companies and looks them up again next time', () => {
    const { script, urlFetch } = setup({
      overrides: {
        '/companies/enrich/batch': () => ({
          body: { items: [{ domain: 'new.example', status: 'pending' }, { domain: 'acme.example', status: 'not-found' }] },
        }),
      },
    });
    expect(script.COMPANYENRICH([['new.example'], ['acme.example']], 'name')).toEqual([
      ['Pending: recalculate later'],
      ['Not found'],
    ]);
    script.COMPANYENRICH([['new.example'], ['acme.example']], 'name');
    // Only the pending domain is looked up again; one new domain uses the single GET.
    expect(urlFetch.to('/companies/enrich/batch')).toHaveLength(1);
    expect(urlFetch.to('/companies/enrich').map((request) => request.query.get('domain'))).toEqual(['new.example']);
  });
});

describe('COMPANYENRICH_ROW', () => {
  it('returns several fields as one row', () => {
    const { script } = setup();
    expect(script.COMPANYENRICH_ROW('globex.example', 'name, industry,employees,country')).toEqual([
      ['Globex', 'Software Development', '201-500', 'Germany'],
    ]);
  });

  it('takes the field list from a range and returns one row per domain', () => {
    const { script, urlFetch } = setup();
    const rows = script.COMPANYENRICH_ROW(
      [['acme.example'], ['unknown.example'], ['']],
      [['name', 'employees', 'location.city.name']],
    );
    expect(rows).toEqual([
      ['Acme', '1K-5K', 'Phoenix'],
      ['Not found', '', ''],
      ['', '', ''],
    ]);
    expect(urlFetch.requests).toHaveLength(1);
  });

  it('rejects a multi-column range of domains', () => {
    const { script } = setup();
    expect(() => script.COMPANYENRICH_ROW([['acme.example', 'globex.example']], 'name')).toThrow(
      'single column of domains',
    );
  });
});

describe('COMPANYENRICH_COUNT', () => {
  it('sends the filter to the free count endpoint and returns the total', () => {
    const { script, urlFetch } = setup();
    expect(script.COMPANYENRICH_COUNT('us', '51-200, 201-500', 'SaaS')).toBe(1234);
    expect(urlFetch.to('/companies/search/count')[0]?.body).toEqual({
      filter: { country: ['US'], employees: ['51-200', '201-500'], categories: ['saas'] },
    });
  });

  it('resolves country names with the free geo search', () => {
    const { script, urlFetch } = setup();
    script.COMPANYENRICH_COUNT('Germany', '', '');
    expect(urlFetch.to('/geo/countries')[0]?.body).toEqual({ query: 'Germany', pageSize: 10 });
    expect(urlFetch.to('/companies/search/count')[0]?.body).toEqual({ filter: { country: ['DE'] } });
  });

  it('prefers an exact country name and explains ambiguous ones', () => {
    const { script } = setup();
    script.COMPANYENRICH_COUNT('india', '', '');
    expect(() => script.COMPANYENRICH_COUNT('ind', '', '')).toThrow(/matches several countries: India \(IN\)/);
    expect(() => script.COMPANYENRICH_COUNT('Atlantis', '', '')).toThrow('Unknown country "Atlantis"');
  });

  it('counts everything when no filter is given', () => {
    const { script, urlFetch } = setup();
    script.COMPANYENRICH_COUNT('', '', '');
    expect(urlFetch.to('/companies/search/count')[0]?.body).toEqual({});
  });

  it('validates employee ranges and categories before calling the API', () => {
    const { script, urlFetch } = setup();
    expect(() => script.COMPANYENRICH_COUNT('US', '50-200', '')).toThrow(/Unknown employee range "50-200"\. Use one of: 1-10/);
    expect(() => script.COMPANYENRICH_COUNT('US', '', 'fintech')).toThrow('Unknown category "fintech"');
    expect(urlFetch.requests).toHaveLength(0);
  });
});
