import type { CompanyEnrich } from '@companyenrich/sdk';
import { MAX_CONCURRENCY, mapLimit } from './concurrency.js';
import { buildTargetFilter, DEFAULT_BREAKDOWN_COUNTRIES, EMPLOYEE_RANGES, type TargetSpec } from './filters.js';
import type { CompanyFilter } from './types.js';

export interface CountRow {
  label: string;
  companies: number;
}

export interface MarketSize {
  /** Companies running the competitor, with the firmographic filters applied. */
  competitorInstalls: number;
  /** Of those, companies that already run your technology too. Undefined without --mine. */
  overlap?: number | undefined;
  /** The displacement market: competitor, not yours. */
  targets: number;
  byCountry: CountRow[];
  byEmployees: CountRow[];
}

/**
 * Free counts, `concurrency` at a time. Uses `total` rather than `count`, because `count`
 * is capped at the plan's search limit (100,000) and large markets would all look the same.
 */
export async function countCompanies(client: CompanyEnrich, filters: readonly CompanyFilter[]): Promise<number[]> {
  return mapLimit(filters, MAX_CONCURRENCY, async (filter) => (await client.companies.count({ filter })).total);
}

/** Sizes the market for free: install base, overlap, targets, and a breakdown by country and employee range. */
export async function sizeMarket(client: CompanyEnrich, spec: TargetSpec): Promise<MarketSize> {
  const target = buildTargetFilter(spec);
  const installs = buildTargetFilter({ ...spec, mine: undefined });
  const overlap = spec.mine ? { ...installs, technologies: { all: [spec.competitor, spec.mine] } } : undefined;

  const countries = spec.countries.length > 0 ? spec.countries : DEFAULT_BREAKDOWN_COUNTRIES;
  const ranges = spec.employees.length > 0 ? spec.employees : EMPLOYEE_RANGES;

  const queries: CompanyFilter[] = [
    target,
    installs,
    ...(overlap ? [overlap] : []),
    ...countries.map((country) => ({ ...target, country })),
    ...ranges.map((employees) => ({ ...target, employees })),
  ];
  const totals = await countCompanies(client, queries);
  const take = (n: number) => totals.splice(0, n);

  const [targets = 0, competitorInstalls = 0] = take(2);
  const overlapCount = overlap ? take(1)[0] : undefined;
  const byCountry = rows(countries, take(countries.length)).sort((a, b) => b.companies - a.companies);
  const byEmployees = rows(ranges, take(ranges.length));

  // Without a country or size filter the rows are a sample of the whole market, so show the remainder.
  if (spec.countries.length === 0) byCountry.push({ label: 'Other or unknown', companies: remainder(targets, byCountry) });
  if (spec.employees.length === 0) byEmployees.push({ label: 'Unknown', companies: remainder(targets, byEmployees) });

  return { competitorInstalls, overlap: overlapCount, targets, byCountry, byEmployees };
}

function rows(labels: readonly string[], counts: number[]): CountRow[] {
  return labels.map((label, index) => ({ label, companies: counts[index] ?? 0 }));
}

function remainder(total: number, rows: readonly CountRow[]): number {
  return Math.max(0, total - rows.reduce((sum, row) => sum + row.companies, 0));
}
