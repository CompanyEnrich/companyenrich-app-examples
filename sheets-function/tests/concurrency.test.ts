import { describe, expect, it } from 'vitest';
import { FakeCache } from '../harness/fakes.js';
import { COMPANIES, problem, setup } from './helpers.js';

const cachedEntry = (domain: string) => JSON.stringify({ domain, company: COMPANIES[domain] });

describe('one paid lookup per domain across cells running at the same time', () => {
  it('a second cell waits instead of buying a domain another cell is fetching', () => {
    let second: unknown;
    const environment = setup({
      overrides: {
        '/companies/enrich': (request) => {
          // While this cell's request is in flight, another cell asks for the same domain.
          second = environment.script.COMPANYENRICH('acme.example', 'industry');
          return { body: COMPANIES[request.query.get('domain') ?? ''] };
        },
      },
    });
    expect(environment.script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(second).toBe('Pending: recalculate later'); // gave up waiting within its time budget
    expect(environment.urlFetch.to('/companies/enrich')).toHaveLength(1);
    expect(environment.script.COMPANYENRICH('acme.example', 'industry')).toBe('Manufacturing');
    expect(environment.urlFetch.requests).toHaveLength(1);
  });

  it('picks up the value as soon as the other cell saves it', () => {
    const cache = new FakeCache();
    cache.put('ce:inflight:acme.example', '1');
    const { script, urlFetch, sleeps } = setup({
      cache,
      onSleep: () => {
        cache.put('ce:company:acme.example', cachedEntry('acme.example'));
        cache.remove('ce:inflight:acme.example');
      },
    });
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(urlFetch.requests).toHaveLength(0);
    expect(sleeps).toEqual([500]);
  });

  it('re-reads the cache under the lock before claiming', () => {
    const { script, urlFetch, lock, cache } = setup();
    const tryLock = lock.tryLock;
    lock.tryLock = () => {
      cache.put('ce:company:acme.example', cachedEntry('acme.example')); // saved by a cell that held the lock
      return tryLock();
    };
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(urlFetch.requests).toHaveLength(0);
  });

  it('releases the claim when the lookup fails, so the next try can fetch', () => {
    let calls = 0;
    const { script, cache, urlFetch } = setup({
      overrides: {
        '/companies/enrich': () => (++calls === 1 ? problem(402, 'No credits') : { body: COMPANIES['acme.example'] }),
      },
    });
    expect(() => script.COMPANYENRICH('acme.example', 'name')).toThrow('(402)');
    expect(cache.get('ce:inflight:acme.example')).toBeNull();
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme');
    expect(urlFetch.requests).toHaveLength(2);
  });

  it('explains a busy lock instead of hanging', () => {
    const { script, urlFetch, lock } = setup();
    lock.busy = true;
    expect(() => script.COMPANYENRICH('acme.example', 'name')).toThrow(
      'Other cells are busy with CompanyEnrich lookups. Recalculate this cell in a moment.',
    );
    expect(urlFetch.requests).toHaveLength(0);
  });
});

describe('the 30-second custom function limit', () => {
  it('starts no new batch after 20 seconds and defers the rest', () => {
    const environment = setup({
      overrides: {
        '/companies/enrich/batch': (request) => {
          environment.clock.now += 12000; // a slow batch call
          return { body: { items: request.body.domains.map((domain: string) => ({ domain, status: 'not-found' })) } };
        },
      },
    });
    const range = Array.from({ length: 120 }, (_, i) => [`c${i}.example`]);
    const values = environment.script.COMPANYENRICH(range, 'name');

    expect(environment.urlFetch.to('/companies/enrich/batch')).toHaveLength(2); // at 0s and 12s, not at 24s
    expect(values[99]).toEqual(['Not found']);
    expect(values[100]).toEqual(['Pending: too many new domains for one formula. Recalculate, or use the sidebar']);
    expect([...environment.cache.store.keys()].filter((key) => key.startsWith('ce:inflight:'))).toEqual([]);

    // The next recalculation picks up only the deferred domains.
    environment.script.COMPANYENRICH(range, 'name');
    expect(environment.urlFetch.to('/companies/enrich/batch').at(-1)?.body.domains).toHaveLength(20);
  });

  it('counts retry waits against the same budget', () => {
    let calls = 0;
    const environment = setup({
      overrides: {
        '/companies/enrich/batch': (request) => {
          calls++;
          if (calls <= 2) return problem(429, 'Slow down', { 'retry-after': '8' });
          environment.clock.now += 5000;
          return { body: { items: request.body.domains.map((domain: string) => ({ domain, status: 'not-found' })) } };
        },
      },
    });
    const range = Array.from({ length: 60 }, (_, i) => [`c${i}.example`]);
    const values = environment.script.COMPANYENRICH(range, 'name');
    // 16 seconds of retry waits plus a 5-second call: the second batch would start past 20 seconds.
    expect(environment.sleeps).toEqual([8000, 8000]);
    expect(environment.urlFetch.to('/companies/enrich/batch')).toHaveLength(3);
    expect(values[49]).toEqual(['Not found']);
    expect(values[50]).toEqual(['Pending: too many new domains for one formula. Recalculate, or use the sidebar']);
  });
});
