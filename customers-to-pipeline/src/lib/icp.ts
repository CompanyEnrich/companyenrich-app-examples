import { UsageError } from './errors.js';
import { assertKnownFilterKeys } from './filter-schema.js';
import { EMPLOYEE_RANGES, REVENUE_RANGES, valuesOf, type Dimension, type Profile } from './profile.js';
import type { Company, CompanySearchFilter, IndustryCodes } from './types.js';

type Category = NonNullable<Company['categories']>[number];

export interface DerivedIcp {
  filter: CompanySearchFilter;
  /** The customer values behind each part of the filter, for the report. */
  selected: Partial<Record<Dimension, string[]>>;
}

/** Values shared by at least `minShare` of customers. Missing data never qualifies. */
function common(profile: Profile, dimension: Dimension, minShare: number): string[] {
  return profile.dimensions[dimension].filter((row) => row.share >= minShare).map((row) => row.value);
}

/** Every range from the smallest to the largest selected one, so 201-500 + 1K-5K also takes 501-1K. */
function fillRange<T extends string>(values: readonly string[], order: readonly T[]): T[] {
  const positions = values.map((value) => order.indexOf(value as T)).filter((index) => index >= 0);
  if (positions.length === 0) return [];
  return order.slice(Math.min(...positions), Math.max(...positions) + 1);
}

/**
 * Builds a v2 CompanySearchFilter from a customer profile. One rule per dimension; a dimension with
 * no value above `minShare` is left out, so it does not constrain the search.
 */
export function deriveIcp(profile: Profile, minShare: number, industryCodes: IndustryCodes): DerivedIcp {
  const filter: CompanySearchFilter = {};
  const selected: DerivedIcp['selected'] = {};

  // Industry: search filters take NAICS codes, not industry names, so each common industry is
  // replaced by its NAICS prefixes from GET /v2/industries. An array matches any code.
  const industries = common(profile, 'industry', minShare).filter((name) => industryCodes.has(name));
  if (industries.length > 0) {
    filter.naicsCodes = [...new Set(industries.flatMap((name) => industryCodes.get(name) ?? []))];
    selected.industry = industries;
  }

  // Categories: a plain array would require every category, `in` matches any of them.
  const categories = common(profile, 'categories', minShare);
  if (categories.length > 0) {
    filter.categories = { in: categories as Category[] };
    selected.categories = categories;
  }

  // Employees and revenue: the common ranges plus any gap between them. An array matches any range.
  const employees = fillRange(common(profile, 'employees', minShare), EMPLOYEE_RANGES);
  if (employees.length > 0) {
    filter.employees = employees;
    selected.employees = employees;
  }
  const revenue = fillRange(common(profile, 'revenue', minShare), REVENUE_RANGES);
  if (revenue.length > 0) {
    filter.revenue = revenue;
    selected.revenue = revenue;
  }

  // Country: the common ISO country codes. An array matches any.
  const countries = common(profile, 'country', minShare);
  if (countries.length > 0) {
    filter.country = countries;
    selected.country = countries;
  }

  // Founded year: from the first year of the earliest common decade to the last year of the latest.
  const decades = common(profile, 'foundedYear', minShare);
  if (decades.length > 0) {
    const starts = decades.map((decade) => Number.parseInt(decade, 10));
    filter.foundedYear = { min: Math.min(...starts), max: Math.max(...starts) + 9 };
    selected.foundedYear = decades;
  }

  // Technologies (only present with --with-tech): `in` matches companies using any of them.
  const technologies = common(profile, 'technologies', minShare);
  if (technologies.length > 0) {
    filter.technologies = { in: technologies };
    selected.technologies = technologies;
  }

  return { filter, selected };
}

type AdvancedRule = { in?: unknown[]; notIn?: unknown[]; all?: unknown[] };
type Rule = string | number | readonly (string | number)[] | AdvancedRule;

const lower = (value: unknown) => String(value).toLowerCase();

/**
 * Checks a company's values against one filter rule. A plain array means "any" for most fields and
 * "every" for collection fields (categories, technologies), as in the API.
 */
function ruleMatches(values: readonly string[], rule: Rule, plainArray: 'any' | 'every'): boolean {
  const have = new Set(values.map(lower));
  const has = (value: unknown) => have.has(lower(value));
  if (typeof rule !== 'object' || Array.isArray(rule)) {
    const wanted = Array.isArray(rule) ? rule : [rule];
    return plainArray === 'every' ? wanted.every(has) : wanted.some(has);
  }
  const { in: anyOf, all, notIn } = rule as AdvancedRule;
  return (anyOf === undefined || anyOf.some(has)) && (all === undefined || all.every(has)) && (notIn === undefined || !notIn.some(has));
}

type Check = (company: Company, rule: never, industryCodes: IndustryCodes) => boolean | undefined;

const list = (values: readonly string[]) => (values.length > 0 ? values : undefined);

/**
 * Local checks for the filter keys this app writes (plus `type`). Each returns undefined when the
 * company has no data for the field, so missing data is neither a match nor a miss.
 */
const CHECKS: Partial<Record<keyof CompanySearchFilter, Check>> = {
  naicsCodes: (company, rule: Rule, industryCodes) => {
    const codes = list(valuesOf(company, 'industry').flatMap((name) => industryCodes.get(name) ?? []));
    return codes && ruleMatches(codes, rule, 'any');
  },
  categories: (company, rule: Rule) => {
    const values = list(valuesOf(company, 'categories'));
    return values && ruleMatches(values, rule, 'every');
  },
  technologies: (company, rule: Rule) => {
    const values = list(valuesOf(company, 'technologies'));
    return values && ruleMatches(values, rule, 'every');
  },
  employees: (company, rule: Rule) => (company.employees ? ruleMatches([company.employees], rule, 'any') : undefined),
  revenue: (company, rule: Rule) => (company.revenue ? ruleMatches([company.revenue], rule, 'any') : undefined),
  country: (company, rule: Rule) => {
    const code = company.location?.country?.code;
    return code ? ruleMatches([code], rule, 'any') : undefined;
  },
  type: (company, rule: Rule) => (company.type ? ruleMatches([company.type], rule, 'any') : undefined),
  foundedYear: (company, rule: { min?: number | null; max?: number | null }) => {
    const year = company.foundedYear;
    if (!year) return undefined;
    return (rule.min == null || year >= rule.min) && (rule.max == null || year <= rule.max);
  },
};

/** Readable names for filter keys in reports. */
export function dimensionLabel(key: string): string {
  return key === 'naicsCodes' ? 'industry' : key;
}

export interface DimensionMatch {
  /** ICP dimensions the company matches, as readable labels. */
  matched: string[];
  /** How many ICP dimensions could be checked with the company's data. */
  checked: number;
}

/** Which ICP dimensions a company matches: the "why" behind an account and the seed ranking. */
export function matchDimensions(company: Company, filter: CompanySearchFilter, industryCodes: IndustryCodes): DimensionMatch {
  const result: DimensionMatch = { matched: [], checked: 0 };
  for (const [key, rule] of Object.entries(filter)) {
    const check = CHECKS[key as keyof CompanySearchFilter];
    if (!check || rule == null) continue;
    const outcome = check(company, rule as never, industryCodes);
    if (outcome === undefined) continue;
    result.checked++;
    if (outcome) result.matched.push(dimensionLabel(key));
  }
  return result;
}

export interface IcpFile {
  filter: CompanySearchFilter;
  about?: string;
  industries?: Record<string, readonly string[]>;
}

/**
 * Reads an icp.json written by an earlier run (and maybe edited). Only `filter` is required, and its
 * field names are checked locally, so a typo fails before any paid call.
 */
export function parseIcpFile(text: string, source: string): CompanySearchFilter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const filter = (parsed as { filter?: unknown } | null)?.filter;
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new UsageError(`${source} needs a "filter" object, like the icp.json files this app writes.`);
  }
  assertKnownFilterKeys(filter as Record<string, unknown>, source);
  return filter as CompanySearchFilter;
}
