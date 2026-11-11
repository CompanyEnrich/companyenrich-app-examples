import { describe, expect, it } from 'vitest';
import { FakeCache, FakeProperties } from '../harness/fakes.js';
import { setup } from './helpers.js';

describe('persistent cache', () => {
  it('stores a compact record without empty values', () => {
    const { script, documentProperties } = setup();
    script.COMPANYENRICH('acme.example', 'name');
    const saved = JSON.parse(documentProperties.getProperty('ce:company:acme.example') ?? '{}');
    expect(saved.savedAt).toEqual(expect.any(Number));
    expect(saved.company.name).toBe('Acme');
    expect(saved.company.location).not.toHaveProperty('address'); // was null
    expect(saved.company.socials).not.toHaveProperty('twitterUrl'); // was ''
  });

  it('drops the oldest saved companies when document properties are full', () => {
    // Measure two saved companies (plus the spending ledger), then leave no room for a third.
    const probe = setup();
    probe.script.COMPANYENRICH('acme.example', 'name');
    probe.script.COMPANYENRICH('globex.example', 'name');
    const quota = probe.documentProperties.sizeInBytes() + 50;

    const documentProperties = new FakeProperties({}, quota);
    const { script, urlFetch } = setup({ documentProperties });
    for (const domain of ['acme.example', 'globex.example', 'initech.example']) {
      script.COMPANYENRICH(domain, 'name');
    }
    expect(companyKeys(documentProperties)).toEqual(['ce:company:globex.example', 'ce:company:initech.example']);
    expect(documentProperties.sizeInBytes()).toBeLessThanOrEqual(quota);

    // Still served from CacheService in this session, so nothing is billed twice.
    script.COMPANYENRICH('acme.example', 'industry');
    expect(urlFetch.requests).toHaveLength(3);
  });

  it('keeps working from CacheService when a record cannot be saved at all', () => {
    const documentProperties = new FakeProperties({}, 100); // fits the ledger, not a company
    const cache = new FakeCache();
    const { script, urlFetch } = setup({ documentProperties, cache });
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(urlFetch.requests).toHaveLength(1);
    expect(companyKeys(documentProperties)).toEqual([]);
  });

  it('clears saved companies from the menu after confirmation', () => {
    const { script, ui, documentProperties, cache, urlFetch } = setup();
    script.COMPANYENRICH([['acme.example'], ['globex.example']], 'name');
    ui.alertAnswer = 'OK';
    script.clearCachedCompanies();
    expect(ui.alerts.at(-1)).toBe('Removed 2 cached companies.');
    expect(companyKeys(documentProperties)).toEqual([]);
    expect(cache.get('ce:company:acme.example')).toBeNull();
    script.COMPANYENRICH('acme.example', 'name');
    expect(urlFetch.requests).toHaveLength(2);
  });

  it('leaves the cache alone when clearing is cancelled', () => {
    const { script, ui, documentProperties } = setup();
    script.COMPANYENRICH('acme.example', 'name');
    ui.alertAnswer = 'CANCEL';
    script.clearCachedCompanies();
    expect(companyKeys(documentProperties)).toEqual(['ce:company:acme.example']);
  });

  it('ignores an entry saved under a different lookup domain', () => {
    const documentProperties = new FakeProperties({
      'ce:company:acme.example': JSON.stringify({ domain: 'globex.example', savedAt: 1, company: { name: 'Globex' } }),
    });
    const { script, urlFetch } = setup({ documentProperties });
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(urlFetch.to('/companies/enrich')).toHaveLength(1);
  });

  it('treats an unreadable entry as a miss', () => {
    const cache = new FakeCache();
    cache.put('ce:company:acme.example', '{not json');
    const { script, urlFetch } = setup({ cache });
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(urlFetch.requests).toHaveLength(1);
  });
});

function companyKeys(properties: FakeProperties): string[] {
  return properties.getKeys().filter((key) => key.startsWith('ce:company:'));
}
