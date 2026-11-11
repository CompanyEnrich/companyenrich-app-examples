import { describe, expect, it } from 'vitest';
import { FileCache } from '../src/lib/file-cache.js';
import { buildCountQueries, cachedQueryCount, runCounts } from '../src/lib/counts.js';
import type { CompanyFilter } from '../src/lib/icp.js';
import { bandScheme } from '../src/lib/weights.js';
import { createFakeApi, loadFixture, type Fixture } from './fake-api.js';

const us = loadFixture('us');
const filter: CompanyFilter = { categories: ['b2b', 'saas'], employees: ['51-200', '201-500'] };
const stateIds = us.states.map((state) => state.id);

describe('buildCountQueries', () => {
  it('asks for the country once and each state once', () => {
    const queries = buildCountQueries(filter, 'US', stateIds, null);
    expect(queries).toHaveLength(1 + stateIds.length);
    expect(queries[0]).toEqual({ stateIndex: null, band: null, filter: { categories: ['b2b', 'saas'], employees: ['51-200', '201-500'], country: 'US' } });
    expect(queries[1]!.filter).toEqual({ categories: ['b2b', 'saas'], employees: ['51-200', '201-500'], country: 'US', state: stateIds[0] });
  });

  it('adds one query per state per band when weighting, replacing the ICP band filter', () => {
    const saas: CompanyFilter = { categories: ['saas'], employees: ['51-200', '201-500'] };
    const queries = buildCountQueries(saas, 'US', [1, 2], bandScheme('employees', saas));
    expect(queries).toHaveLength(1 + 2 * (1 + 2));
    expect(queries.filter((query) => query.band !== null).map((query) => query.filter)).toEqual([
      { categories: ['saas'], employees: '51-200', country: 'US', state: 1 },
      { categories: ['saas'], employees: '201-500', country: 'US', state: 1 },
      { categories: ['saas'], employees: '51-200', country: 'US', state: 2 },
      { categories: ['saas'], employees: '201-500', country: 'US', state: 2 },
    ]);
  });
});

describe('runCounts', () => {
  it('aggregates per-state and per-band counts with at most 4 requests in flight', async () => {
    const api = createFakeApi([us], { delayMs: 2 });
    const scheme = bandScheme('employees', filter);
    const queries = buildCountQueries(filter, 'US', stateIds, scheme);
    const progress: number[] = [];
    const run = await runCounts(api.client, queries, stateIds.length, FileCache.inMemory<number>(), {
      onProgress: (done) => progress.push(done),
    });

    expect(api.requests).toHaveLength(queries.length);
    expect(api.paths().every((path) => path === '/v2/companies/search/count')).toBe(true);
    expect(api.maxInFlight).toBe(4);
    expect(progress.at(-1)).toBe(queries.length);
    expect(run.countryTotal).toBe(us.countryTotal);
    const california = us.states.findIndex((state) => state.code === 'CA');
    expect(run.states[california]).toEqual({
      companies: us.states[california]!.companies,
      bands: us.states[california]!.bands,
    });
  });

  it('uses the uncapped total, not the plan-limited count', async () => {
    const big: Fixture = {
      country: { code: 'US', name: 'United States' },
      countryTotal: 250_000,
      states: [{ id: 1, code: 'CA', name: 'California', latitude: 0, longitude: 0, companies: 150_000 }],
    };
    const api = createFakeApi([big], { planLimit: 100_000 });
    const run = await runCounts(api.client, buildCountQueries({}, 'US', [1], null), 1, FileCache.inMemory<number>());
    expect(run.countryTotal).toBe(250_000);
    expect(run.states[0]!.companies).toBe(150_000);
  });

  it('answers repeat queries from the cache without calling the API', async () => {
    const cache = FileCache.inMemory<number>();
    const queries = buildCountQueries(filter, 'US', stateIds, null);
    await runCounts(createFakeApi([us]).client, queries, stateIds.length, cache);

    const api = createFakeApi([us]);
    expect(cachedQueryCount(queries, cache)).toBe(queries.length);
    const run = await runCounts(api.client, queries, stateIds.length, cache);
    expect(api.requests).toHaveLength(0);
    expect(run.fromCache).toBe(queries.length);
  });
});
