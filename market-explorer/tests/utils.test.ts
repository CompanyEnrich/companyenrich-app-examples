import { describe, expect, it } from 'vitest';
import { LruCache, stableStringify } from '@/lib/cache';
import { costLadder, searchCredits } from '@/lib/cost';
import { HEAT_LEVELS, heatLegend, heatLevel } from '@/lib/heat';
import { curlSnippet, filterJson, sdkSnippet } from '@/lib/snippets';

describe('cost', () => {
  it('prices search per result, with a one-result minimum', () => {
    expect(searchCredits('filter', 10)).toBe(10);
    expect(searchCredits('semantic', 10)).toBe(20);
    expect(searchCredits('lookalike', 3)).toBe(15);
    expect(searchCredits('filter', 0)).toBe(1);
  });

  it('builds a ladder capped at the match count', () => {
    expect(costLadder('filter', 42)).toEqual([
      { results: 10, credits: 10 },
      { results: 42, credits: 42 },
    ]);
    expect(costLadder('filter', 5_000)).toEqual([
      { results: 10, credits: 10 },
      { results: 100, credits: 100 },
      { results: 1_000, credits: 1_000 },
      { results: 5_000, credits: 5_000 },
    ]);
    expect(costLadder('semantic', 3)).toEqual([{ results: 3, credits: 6 }]);
    expect(costLadder('filter', 0)).toEqual([]);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<number>(2, 1_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
  });

  it('expires entries after the ttl', () => {
    let now = 0;
    const cache = new LruCache<number>(10, 100, () => now);
    cache.set('a', 1);
    now = 99;
    expect(cache.get('a')).toBe(1);
    now = 200;
    expect(cache.get('a')).toBeUndefined();
  });

  it('shares one in-flight computation and does not cache failures', async () => {
    const cache = new LruCache<number>(10, 1_000);
    let calls = 0;
    const compute = async () => ++calls;
    const [a, b] = await Promise.all([cache.getOrCompute('k', compute), cache.getOrCompute('k', compute)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);

    await expect(cache.getOrCompute('bad', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    await expect(cache.getOrCompute('bad', async () => 7)).resolves.toBe(7);
  });

  it('builds the same key for objects with different key order', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: 0 } })).toBe(stableStringify({ a: { c: 0, d: [2, 1] }, b: 1 }));
  });
});

describe('heat scale', () => {
  it('reserves level 0 for empty cells and grows with count', () => {
    expect(heatLevel(0, 1_000)).toBe(0);
    expect(heatLevel(1, 1_000)).toBe(1);
    expect(heatLevel(1_000, 1_000)).toBe(HEAT_LEVELS);
    const levels = [1, 10, 100, 1_000, 10_000, 100_000].map((n) => heatLevel(n, 100_000));
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it('gives each legend step the smallest count that reaches it', () => {
    const legend = heatLegend(100_000);
    expect(legend[0]).toEqual({ level: 1, from: 1 });
    for (const step of legend) {
      expect(heatLevel(step.from, 100_000)).toBe(step.level);
      if (step.from > 1) expect(heatLevel(step.from - 1, 100_000)).toBeLessThan(step.level);
    }
    expect(heatLegend(0)).toEqual([]);
  });
});

describe('snippets', () => {
  const filter = { country: ['DE'], technologies: { all: ['stripe'], notIn: ['shopify'] } };

  it('exports the filter as JSON', () => {
    expect(JSON.parse(filterJson(filter))).toEqual(filter);
  });

  it('writes an SDK snippet with the free count and the paid search', () => {
    const code = sdkSnippet(filter);
    expect(code).toContain("import { CompanyEnrich, type components } from '@companyenrich/sdk';");
    expect(code).toContain('const filter: CompanySearchFilter = {');
    expect(code).toContain('client.companies.count({ filter })');
    expect(code).toContain('client.companies.search({ filter, pageSize: 25 })');
    expect(code).toContain('"notIn": [\n      "shopify"\n    ]');
  });

  it('writes a curl command for the count endpoint with safe shell quoting', () => {
    const command = curlSnippet({ keywords: ["women's health"] });
    expect(command).toContain('https://api.companyenrich.com/v2/companies/search/count');
    expect(command).toContain('Authorization: Bearer $COMPANYENRICH_API_KEY');
    expect(command).toContain(`-d '{"filter":{"keywords":["women'\\''s health"]}}'`);
  });
});
