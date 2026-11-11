import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthenticationError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { FileCache } from '../src/lib/file-cache.js';
import type { SampleResult } from '../src/lib/sample.js';
import { describeError, UsageError } from '../src/lib/errors.js';
import { runPlanner, type PlannerOptions } from '../src/lib/planner.js';
import { createFakeApi, loadFixture } from './fake-api.js';

const us = loadFixture('us');
const de = loadFixture('de');

function options(overrides: Partial<PlannerOptions> = {}): PlannerOptions {
  return {
    icp: { categories: ['b2b', 'saas'], employees: ['51-200', '201-500'] },
    country: 'US',
    territories: 4,
    reps: ['Ana', 'Ben', 'Chen', 'Dee'],
    weightBy: 'none',
    keepRegions: false,
    sample: 0,
    maxCredits: 20,
    dryRun: false,
    cache: FileCache.inMemory<number>(),
    sampleStore: FileCache.inMemory<SampleResult>(),
    runId: 'test-run',
    now: new Date('2026-11-11T10:00:00Z'),
    ...overrides,
  };
}

const FREE_PATHS = ['/v2/geo/countries/US', '/v2/geo/countries/DE', '/v2/geo/states', '/v2/companies/search/count'];

describe('runPlanner, default free run', () => {
  it('uses only free endpoints and spends 0 credits', async () => {
    const api = createFakeApi([us]);
    const report = await runPlanner(api.client, options());
    expect(new Set(api.paths()).size).toBeGreaterThan(0);
    expect(api.paths().every((path) => FREE_PATHS.includes(path))).toBe(true);
    expect(report.credits.spent).toBe(0);
    expect(report.counts.requests).toBe(1 + us.states.length);
  });

  it('places every state once and the territory totals add up to the placed companies', async () => {
    const report = await runPlanner(createFakeApi([us]).client, options());
    const placed = report.territories.flatMap((territory) => territory.states.map((state) => state.id));
    expect(placed.sort()).toEqual(us.states.map((state) => state.id).sort());
    const sum = report.territories.reduce((total, territory) => total + territory.companies, 0);
    expect(sum).toBe(us.states.reduce((total, state) => total + state.companies, 0));
    expect(report.coverage).toEqual({ countryTotal: us.countryTotal, placed: sum });
    expect(report.territories.map((territory) => territory.rep)).toEqual(['Ana', 'Ben', 'Chen', 'Dee']);
    expect(report.territories.reduce((total, territory) => total + territory.share, 0)).toBeCloseTo(1);
  });

  it('warns when one state is larger than an even share', async () => {
    const report = await runPlanner(createFakeApi([us]).client, options());
    expect(report.warnings[0]).toMatch(/^California alone holds 25\.4% of ICP companies/);
  });

  it('weights by employees with one extra count per state per band', async () => {
    const api = createFakeApi([us]);
    const report = await runPlanner(api.client, options({ weightBy: 'employees' }));
    expect(report.counts.requests).toBe(1 + us.states.length * 3);
    const california = report.territories.flatMap((t) => t.states).find((state) => state.code === 'CA')!;
    const bands = us.states.find((state) => state.code === 'CA')!.bands!;
    expect(california.weight).toBeCloseTo(bands['51-200']! * 125.5 + bands['201-500']! * 350.5);
  });

  it('keeps Census divisions together with --keep-regions', async () => {
    const report = await runPlanner(createFakeApi([us]).client, options({ keepRegions: true }));
    expect(report.splitRegions).toEqual(['Pacific']);
    expect(report.keptRegions).toContain('New England');
  });

  it('plans a non-US country', async () => {
    const report = await runPlanner(createFakeApi([de]).client, options({ country: 'DE', territories: 3, reps: [] }));
    expect(report.country).toEqual({ code: 'DE', name: 'Germany' });
    expect(report.territories).toHaveLength(3);
    expect(report.balance.maxMinRatio!).toBeLessThan(1.01);
  });
});

describe('runPlanner, paid sample', () => {
  it('fetches each territory with one search sized to the sample and its state ids', async () => {
    const api = createFakeApi([us]);
    const report = await runPlanner(api.client, options({ sample: 2 }));
    const searches = api.requests.filter((request) => request.path === '/v2/companies/search');
    expect(searches).toHaveLength(4);
    searches.forEach((search, index) => {
      expect(search.body?.pageSize).toBe(2);
      const filter = search.body?.filter as { state: number[]; country: string };
      expect(filter.country).toBe('US');
      expect(filter.state).toEqual(report.territories[index]!.states.map((state) => state.id).sort((a, b) => a - b));
    });
    expect(report.credits).toMatchObject({ spent: 8, sampleEstimate: 8 });
    expect(report.territories.every((territory) => territory.samples?.length === 2)).toBe(true);
  });

  it('keeps accounts and credits already paid for when a later search fails', async () => {
    const api = createFakeApi([us], { failSearchesAfter: 2 });
    const report = await runPlanner(api.client, options({ sample: 2 }));
    expect(report.credits).toMatchObject({ spent: 4, sampleFailed: true });
    expect(report.credits.sampleNote).toMatch(/^Sample stopped at territory 3 after 4 credits: CompanyEnrich returned 500/);
    expect(report.territories.map((territory) => territory.samples?.length ?? 0)).toEqual([2, 2, 0, 0]);
  });

  it('resumes after a failure: a re-run with the same options buys only the unfinished territories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'territory-samples-'));
    const file = join(dir, 'samples.json');
    const searchesOf = (api: ReturnType<typeof createFakeApi>) =>
      api.requests.filter((request) => request.path === '/v2/companies/search');

    // First run: territories 1 and 2 succeed, territory 3 fails.
    const failing = createFakeApi([us], { failSearchesAfter: 2 });
    const first = await runPlanner(failing.client, options({ sample: 2, sampleStore: await FileCache.open<SampleResult>(file) }));
    expect(first.credits).toMatchObject({ spent: 4, sampleFailed: true });

    // Second run, as a new process would do it: reopen the store from disk.
    const healthy = createFakeApi([us]);
    const second = await runPlanner(healthy.client, options({ sample: 2, sampleStore: await FileCache.open<SampleResult>(file) }));
    const resumed = searchesOf(healthy).map((search) => (search.body?.filter as { state: number[] }).state);
    const expected = second.territories.slice(2).map((territory) => territory.states.map((state) => state.id).sort((a, b) => a - b));
    expect(resumed).toEqual(expected);
    expect(second.credits).toMatchObject({ spent: 4, sampleEstimate: 4, sampleReused: 2, sampleFailed: false });
    expect(second.territories.every((territory) => territory.samples?.length === 2)).toBe(true);

    // A third run finds everything saved and spends nothing.
    const third = createFakeApi([us]);
    const done = await runPlanner(third.client, options({ sample: 2, sampleStore: await FileCache.open<SampleResult>(file) }));
    expect(searchesOf(third)).toHaveLength(0);
    expect(third.paths()).not.toContain('/v2/me');
    expect(done.credits).toMatchObject({ spent: 0, sampleReused: 4 });
  });

  it('buys again when the request changes, for example a different sample size', async () => {
    const store = FileCache.inMemory<SampleResult>();
    await runPlanner(createFakeApi([us]).client, options({ sample: 1, sampleStore: store }));
    const api = createFakeApi([us]);
    const report = await runPlanner(api.client, options({ sample: 2, sampleStore: store }));
    expect(api.paths().filter((path) => path === '/v2/companies/search')).toHaveLength(4);
    expect(report.credits.spent).toBe(8);
  });

  it('refuses before any request when the sample could exceed --max-credits', async () => {
    const api = createFakeApi([us]);
    await expect(runPlanner(api.client, options({ sample: 3, maxCredits: 10 }))).rejects.toThrow(/up to 12 credits, over --max-credits 10/);
    expect(api.requests).toHaveLength(0);
  });

  it('prints the estimate and fetches nothing on a dry run', async () => {
    const api = createFakeApi([us]);
    const report = await runPlanner(api.client, options({ sample: 5, maxCredits: 0, dryRun: true }));
    expect(api.paths()).not.toContain('/v2/companies/search');
    expect(report.credits).toMatchObject({ spent: 0, sampleEstimate: 20 });
    expect(report.credits.sampleNote).toMatch(/Dry run/);
  });
});

describe('runPlanner, input and API errors', () => {
  it('rejects --keep-regions outside the US before calling the API', async () => {
    const api = createFakeApi([de]);
    await expect(runPlanner(api.client, options({ country: 'DE', keepRegions: true }))).rejects.toThrow(UsageError);
    expect(api.requests).toHaveLength(0);
  });

  it('explains an unknown country code', async () => {
    await expect(runPlanner(createFakeApi([us]).client, options({ country: 'XX' }))).rejects.toThrow(/does not know the country code "XX"/);
  });

  it('turns a rejected API key into one readable line', async () => {
    const api = createFakeApi([us], { failPath: { path: '/v2/geo/countries/US', status: 401 } });
    const error = await runPlanner(api.client, options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(describeError(error)).toMatch(/^CompanyEnrich rejected the API key \(401\)/);
  });

  it('saves every finished count to disk when a later request fails, so a re-run resumes', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'territory-counts-')), 'counts.json');
    // A delay keeps several requests in flight when the 11th fails; they must finish and be saved.
    const api = createFakeApi([us], { failCountsAfter: 10, delayMs: 5 });
    await expect(runPlanner(api.client, options({ cache: await FileCache.open<number>(file) }))).rejects.toThrow(/Simulated outage/);
    expect((await FileCache.open<number>(file)).size).toBe(10);
  });

  it('passes input errors through and leaves unexpected errors to the stack trace', () => {
    expect(describeError(new UsageError('Pass --icp.'))).toBe('Pass --icp.');
    expect(describeError(new TypeError('bug'))).toBeUndefined();
  });
});
