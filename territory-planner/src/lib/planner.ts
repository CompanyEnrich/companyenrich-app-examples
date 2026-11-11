import { NotFoundError, type CompanyEnrich, type GeoState } from '@companyenrich/sdk';
import type { FileCache } from './file-cache.js';
import { buildCountQueries, cachedQueryCount, COUNT_CONCURRENCY, runCounts } from './counts.js';
import { describeError, UsageError } from './errors.js';
import { describeIcp, type CompanyFilter } from './icp.js';
import type { Balance } from './partition.js';
import {
  estimateSampleCredits,
  fetchSampleAccounts,
  maxSampleCredits,
  sampleKey,
  sampleRequest,
  type SampleAccount,
  type SampleRequest,
  type SampleResult,
} from './sample.js';
import { planTerritories, type StateInput } from './territories.js';
import { usCensusDivision } from './us-geo.js';
import { bandScheme, weightStates, type WeightBy } from './weights.js';

export interface PlannerOptions {
  icp: CompanyFilter;
  /** Two-letter country code, upper case. */
  country: string;
  territories: number;
  /** One name per territory, or empty for unassigned territories. */
  reps: string[];
  weightBy: WeightBy;
  keepRegions: boolean;
  /** Example accounts to fetch per territory with paid searches; 0 skips the paid step. */
  sample: number;
  maxCredits: number;
  dryRun: boolean;
  /** Free counts, cached for a day. */
  cache: FileCache<number>;
  /** Paid sample results, saved per territory search so a re-run never pays twice. */
  sampleStore: FileCache<SampleResult>;
  runId: string;
  now: Date;
}

export interface PlannerEvents {
  info?: (message: string) => void;
  progress?: (done: number, total: number) => void;
}

export interface TerritoryState {
  id: number;
  code: string | null;
  name: string;
  companies: number;
  weight: number;
}

export interface Territory {
  number: number;
  rep: string | null;
  states: TerritoryState[];
  companies: number;
  weight: number;
  /** This territory's share of the total weight. */
  share: number;
  /** Difference from an even split, as a fraction of the mean: +0.02 is 2% above. */
  vsEven: number;
  samples: SampleAccount[] | null;
}

export interface PlanReport {
  runId: string;
  generatedAt: string;
  country: { code: string; name: string };
  icp: CompanyFilter;
  icpSummary: string;
  weightBy: WeightBy;
  weighting: { bands: string[]; midpoints: Record<string, number>; bandedCompanies: number; fallbackMidpoint: number } | null;
  keepRegions: boolean;
  keptRegions: string[];
  splitRegions: string[];
  territories: Territory[];
  balance: Balance;
  /** ICP companies in the whole country, and how many of them have a state on file and were placed. */
  coverage: { countryTotal: number; placed: number };
  counts: { requests: number; fromCache: number };
  /**
   * `spent` is what this run was billed. `sampleReused` counts territories whose sample came from an
   * earlier run's saved results. `sampleNote` explains a dry run or a sample that stopped early.
   */
  credits: { spent: number; sampleEstimate: number; sampleReused: number; sampleNote: string | null; sampleFailed: boolean };
  /** Caveats about this plan, such as a state too large for an even split. */
  warnings: string[];
}

/**
 * A state heavier than an even share caps how even any state-level plan can be: its territory is
 * at least that heavy, so say so instead of letting the ratio look like an algorithm failure.
 */
function oversizedStateWarning(states: readonly StateInput[], territoryCount: number, basis: string): string | null {
  const total = states.reduce((sum, state) => sum + state.weight, 0);
  const heaviest = states.reduce((best, state) => (state.weight > best.weight ? state : best), states[0]!);
  if (total === 0 || heaviest.weight <= total / territoryCount) return null;
  const share = ((heaviest.weight / total) * 100).toFixed(1);
  const even = (100 / territoryCount).toFixed(1);
  return `${heaviest.name} alone holds ${share}% of ${basis}, more than an even share (${even}%), so its territory is the largest whatever the split. Use fewer territories, or split ${heaviest.name} further by hand.`;
}

async function loadCountry(client: CompanyEnrich, code: string): Promise<{ name: string; states: GeoState[] }> {
  let name: string;
  try {
    name = (await client.geo.country(code)).name;
  } catch (error) {
    if (error instanceof NotFoundError) throw new UsageError(`CompanyEnrich does not know the country code "${code}". Use a two-letter ISO code such as US, DE or GB.`);
    throw error;
  }
  const states: GeoState[] = [];
  for await (const state of client.geo.searchStatesAll({ countryCodes: [code], pageSize: 100 })) states.push(state);
  if (states.length === 0) throw new UsageError(`CompanyEnrich lists no states for ${name}, so it cannot be split by state.`);
  return { name, states };
}

interface SampleRun {
  spent: number;
  estimate: number;
  reused: number;
  note: string | null;
  failed: boolean;
}

/**
 * The optional paid step: one search per territory. Each finished search is saved to the sample
 * store before the next one starts, keyed by its exact request, so a run that stops partway keeps
 * what it paid for and running the same command again only buys the territories still missing.
 */
async function runSample(
  client: CompanyEnrich,
  territories: Territory[],
  { icp, country, sample, maxCredits, dryRun, sampleStore }: PlannerOptions,
  info: (message: string) => void,
): Promise<SampleRun> {
  const requests = territories.map((territory) =>
    sampleRequest(icp, country, territory.states.map((state) => state.id), territory.companies, sample),
  );
  const saved = requests.map((request) => (request ? sampleStore.get(sampleKey(request)) : undefined));
  const pending = requests.filter((request, index): request is SampleRequest => request !== null && !saved[index]);
  const reused = saved.filter(Boolean).length;
  const estimate = estimateSampleCredits(pending);
  const reuseNote = reused > 0 ? ` ${reused} territories reuse results saved by an earlier run, at no cost.` : '';

  if (dryRun) {
    const note = `Dry run: --sample ${sample} would cost ${estimate} credits; nothing was fetched.${reuseNote}`;
    info(note);
    return { spent: 0, estimate, reused, note, failed: false };
  }
  if (pending.length > 0) {
    const me = await client.me();
    const balance = Math.floor(me.credits.total - me.credits.used).toLocaleString('en-US');
    info(`Fetching ${sample} sample accounts per territory with paid searches: ${estimate} credits (cap ${maxCredits}, balance ${balance}).${reuseNote}`);
  } else if (reused > 0) {
    info(`All ${reused} territory samples were saved by an earlier run: 0 credits.`);
  }

  let spent = 0;
  for (const [index, territory] of territories.entries()) {
    const request = requests[index];
    const savedResult = saved[index];
    if (!request) {
      territory.samples = [];
    } else if (savedResult) {
      territory.samples = savedResult.accounts;
    } else {
      try {
        const result = await fetchSampleAccounts(client, request);
        territory.samples = result.accounts;
        spent += result.creditsSpent;
        sampleStore.set(sampleKey(request), result);
        await sampleStore.save();
      } catch (error) {
        const reason = describeError(error) ?? String(error);
        return { spent, estimate, reused, note: `Sample stopped at territory ${territory.number} after ${spent} credits: ${reason}`, failed: true };
      }
    }
  }
  return { spent, estimate, reused, note: null, failed: false };
}

/** Free counts, weighting and partitioning, plus the optional paid sample. Writes nothing to disk. */
export async function runPlanner(client: CompanyEnrich, options: PlannerOptions, events: PlannerEvents = {}): Promise<PlanReport> {
  const { icp, country: code, territories: territoryCount, sample, cache } = options;
  const info = events.info ?? (() => {});

  if (options.keepRegions && code !== 'US') {
    throw new UsageError('--keep-regions uses US Census divisions, so it only works with --country US.');
  }
  if (sample > 0 && !options.dryRun && maxSampleCredits(territoryCount, sample) > options.maxCredits) {
    throw new UsageError(
      `--sample ${sample} across ${territoryCount} territories can cost up to ${maxSampleCredits(territoryCount, sample)} credits, over --max-credits ${options.maxCredits}. Raise --max-credits or lower --sample.`,
    );
  }
  const scheme = bandScheme(options.weightBy, icp);
  if (scheme && scheme.bands.length === 0) {
    throw new UsageError(`The ICP excludes every ${scheme.field} band, so there is nothing to weight by.`);
  }

  const country = await loadCountry(client, code);
  info(
    sample > 0 && !options.dryRun
      ? `Planning ${territoryCount} territories in ${country.name}. Counts are free; --sample ${sample} spends up to ${maxSampleCredits(territoryCount, sample)} credits (cap ${options.maxCredits}).`
      : `Planning ${territoryCount} territories in ${country.name}. This run uses only free endpoints: 0 credits.`,
  );
  const queries = buildCountQueries(icp, code, country.states.map((state) => state.id), scheme);
  const cached = cachedQueryCount(queries, cache);
  const perState = scheme ? `1 total + ${scheme.bands.length} ${scheme.field} bands (${scheme.bands.join(', ')})` : '1 count';
  info(
    `Counting ICP companies in ${country.states.length} ${country.name} states: ${country.states.length} x ${perState}, plus 1 country total = ${queries.length} free count requests` +
      `${cached > 0 ? ` (${cached} cached)` : ''}, ${COUNT_CONCURRENCY} at a time. Cost: 0 credits.`,
  );

  // Save even after a failure, so a re-run resumes from the counts that did finish.
  const counts = await runCounts(client, queries, country.states.length, cache, { onProgress: events.progress })
    .finally(() => cache.save());

  const weighting = weightStates(counts.states, scheme);
  const inputs: StateInput[] = country.states.map((state, index) => ({
    id: state.id,
    code: state.code ?? null,
    name: state.name,
    companies: counts.states[index]!.companies,
    weight: weighting.weights[index]!,
    latitude: state.latitude ?? null,
    longitude: state.longitude ?? null,
  }));
  const warnings: string[] = [];
  const oversized = oversizedStateWarning(inputs, territoryCount, scheme ? `the estimated ${scheme.mode}` : 'ICP companies');
  if (oversized) {
    warnings.push(oversized);
    info(`Note: ${oversized}`);
  }
  const plan = planTerritories(inputs, {
    territories: territoryCount,
    regionOf: options.keepRegions ? (state) => usCensusDivision(state.code ?? undefined) : undefined,
  });

  const totalWeight = plan.territories.flat().reduce((sum, state) => sum + state.weight, 0);
  const territories: Territory[] = plan.territories.map((states, index) => {
    const weight = states.reduce((sum, state) => sum + state.weight, 0);
    return {
      number: index + 1,
      rep: options.reps[index] ?? null,
      states: states.map(({ id, code: stateCode, name, companies, weight: stateWeight }) => ({
        id, code: stateCode, name, companies, weight: stateWeight,
      })),
      companies: states.reduce((sum, state) => sum + state.companies, 0),
      weight,
      share: totalWeight > 0 ? weight / totalWeight : 0,
      vsEven: plan.balance.mean > 0 ? (weight - plan.balance.mean) / plan.balance.mean : 0,
      samples: null,
    };
  });

  const sampleRun = sample > 0 ? await runSample(client, territories, options, info) : null;

  return {
    runId: options.runId,
    generatedAt: options.now.toISOString(),
    country: { code, name: country.name },
    icp,
    icpSummary: describeIcp(icp),
    weightBy: options.weightBy,
    weighting: scheme
      ? { bands: scheme.bands, midpoints: Object.fromEntries(scheme.bands.map((band) => [band, scheme.midpoints[band]!])), bandedCompanies: weighting.bandedCompanies, fallbackMidpoint: weighting.fallbackMidpoint }
      : null,
    keepRegions: options.keepRegions,
    keptRegions: plan.keptRegions,
    splitRegions: plan.splitRegions,
    territories,
    balance: plan.balance,
    coverage: { countryTotal: counts.countryTotal, placed: counts.states.reduce((sum, state) => sum + state.companies, 0) },
    counts: { requests: counts.requests, fromCache: counts.fromCache },
    credits: {
      spent: sampleRun?.spent ?? 0,
      sampleEstimate: sampleRun?.estimate ?? 0,
      sampleReused: sampleRun?.reused ?? 0,
      sampleNote: sampleRun?.note ?? null,
      sampleFailed: sampleRun?.failed ?? false,
    },
    warnings,
  };
}
