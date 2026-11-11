import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompanyCache, enrichMissing, loadCached } from '../src/lib/enrich.js';
import { fakeApi, makeCompany } from './fake-api.js';

const tempCache = async () => new CompanyCache(await mkdtemp(path.join(os.tmpdir(), 'customers-to-pipeline-cache-')));

describe('enrichment cache', () => {
  it('serves cached companies without calling the API', async () => {
    const cache = await tempCache();
    await cache.set('acme.example', [], makeCompany('acme.example'));

    const cached = await loadCached(['acme.example', 'beta.example'], [], cache);
    expect([...cached.keys()]).toEqual(['acme.example']);
  });

  it('does not reuse an entry fetched without an expansion the run now needs', async () => {
    const cache = await tempCache();
    await cache.set('acme.example', [], makeCompany('acme.example'));
    expect(await cache.get('acme.example', ['technologies'])).toBeUndefined();

    await cache.set('acme.example', ['technologies'], makeCompany('acme.example', { technologies: ['React'] }));
    expect((await cache.get('acme.example', []))?.technologies).toEqual(['React']);
  });
});

describe('enrichMissing', () => {
  it('sends at most 50 domains per request and bills each company found once', async () => {
    const known = Array.from({ length: 60 }, (_, index) => makeCompany(`c${index}.example`));
    const api = fakeApi({ known });
    const domains = [...known.map((company) => company.domain), 'ghost.example'];

    const result = await enrichMissing(api.client, domains, ['technologies'], await tempCache());

    expect(api.callsTo('/v2/companies/enrich/batch').map((call) => call.body?.domains.length)).toEqual([50, 11]);
    expect(api.callsTo('/v2/companies/enrich/batch')[0]?.body?.expand).toEqual(['technologies']);
    expect(result.companies.size).toBe(60);
    expect(result.notFound).toEqual(['ghost.example']);
    expect(result.credits).toBe(120); // 60 companies x (1 + 1 expansion)
  });
});

describe('cache entry validation', () => {
  it('ignores a file that was written for another lookup domain', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'customers-to-pipeline-cache-'));
    const cache = new CompanyCache(dir);
    await cache.set('a.example', [], makeCompany('a.example'));
    await copyFile(path.join(dir, 'a.example.json'), path.join(dir, 'b.example.json'));

    expect(await cache.get('b.example', [])).toBeUndefined();
    expect((await cache.get('a.example', []))?.domain).toBe('a.example');
  });

  it('keeps an alias whose company has a different primary domain', async () => {
    const cache = await tempCache();
    await cache.set('acme.io', [], makeCompany('acme.com'));
    expect((await cache.get('acme.io', []))?.domain).toBe('acme.com');
  });

  it('treats malformed files as a cache miss', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'customers-to-pipeline-cache-'));
    await writeFile(path.join(dir, 'a.example.json'), '{"domain": "a.example", "expand": [], "company": {}}');
    await writeFile(path.join(dir, 'b.example.json'), '{not json');
    const cache = new CompanyCache(dir);
    expect(await cache.get('a.example', [])).toBeUndefined();
    expect(await cache.get('b.example', [])).toBeUndefined();
  });
});
