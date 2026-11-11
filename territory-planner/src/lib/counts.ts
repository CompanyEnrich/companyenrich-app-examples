import type { CompanyEnrich } from '@companyenrich/sdk';
import { mapWithConcurrency } from './concurrency.js';
import { stableKey, type FileCache } from './file-cache.js';
import type { CompanyFilter } from './icp.js';
import type { BandScheme, StateCounts } from './weights.js';

export const COUNT_CONCURRENCY = 4;

/** One free `companies.count` request. `stateIndex` is null for the whole-country total. */
export interface CountQuery {
  stateIndex: number | null;
  band: string | null;
  filter: CompanyFilter;
}

/**
 * Every count the plan needs: the whole country once (to measure how many ICP companies have a
 * state on file), each state once, and with weighting each state once per band.
 */
export function buildCountQueries(
  icp: CompanyFilter,
  country: string,
  stateIds: readonly number[],
  scheme: BandScheme | null,
): CountQuery[] {
  const queries: CountQuery[] = [{ stateIndex: null, band: null, filter: { ...icp, country } }];
  stateIds.forEach((state, stateIndex) => {
    queries.push({ stateIndex, band: null, filter: { ...icp, country, state } });
    if (!scheme) return;
    for (const band of scheme.bands) {
      queries.push({ stateIndex, band, filter: { ...icp, country, state, [scheme.field]: band } });
    }
  });
  return queries;
}

/** How many of the queries the cache can already answer, so the CLI can say what will be sent. */
export function cachedQueryCount(queries: readonly CountQuery[], cache: FileCache<number>): number {
  return queries.filter((query) => cache.get(stableKey(query.filter)) !== undefined).length;
}

export interface CountRun {
  /** ICP companies in the country, with or without a state on file. */
  countryTotal: number;
  /** Counts per state, in the order of `stateIds`. */
  states: StateCounts[];
  requests: number;
  fromCache: number;
}

/**
 * Runs the count queries, at most `concurrency` at a time, reading and filling the cache.
 * Uses `total` (the raw population) rather than `count`, which is capped by the plan's search limit.
 */
export async function runCounts(
  client: CompanyEnrich,
  queries: readonly CountQuery[],
  stateCount: number,
  cache: FileCache<number>,
  { concurrency = COUNT_CONCURRENCY, onProgress }: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<CountRun> {
  let done = 0;
  let fromCache = 0;
  const values = await mapWithConcurrency(queries, concurrency, async (query) => {
    const key = stableKey(query.filter);
    let value = cache.get(key);
    if (value === undefined) {
      value = (await client.companies.count({ filter: query.filter })).total;
      cache.set(key, value);
    } else {
      fromCache++;
    }
    onProgress?.(++done, queries.length);
    return value;
  });

  const states: StateCounts[] = Array.from({ length: stateCount }, () => ({ companies: 0, bands: {} }));
  let countryTotal = 0;
  queries.forEach((query, index) => {
    const value = values[index] ?? 0;
    if (query.stateIndex === null) {
      countryTotal = value;
      return;
    }
    const state = states[query.stateIndex]!;
    if (query.band === null) state.companies = value;
    else state.bands[query.band] = value;
  });
  return { countryTotal, states, requests: queries.length, fromCache };
}
