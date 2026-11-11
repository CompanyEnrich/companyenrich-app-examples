/**
 * The filter builder's state, and its conversion to and from the v2
 * `CompanySearchFilter`. The UI edits `FilterState`; everything sent to the API
 * goes through `toApiFilter`, and anything the API sends back (the semantic
 * interpretation) comes in through `fromApiFilter`.
 */
import {
  CATEGORIES,
  COMPANY_TYPES,
  EMPLOYEE_RANGES,
  FUNDING_ROUNDS,
  GROWTH_DEPARTMENTS,
  GROWTH_PERIODS,
  REVENUE_RANGES,
  countryName,
  regionName,
  type Category,
  type CompanyFilter,
  type CompanyType,
  type EmployeeRange,
  type FundingRound,
  type GrowthDepartment,
  type GrowthPeriod,
  type RevenueRange,
} from './options';

export interface Option<V extends string | number = string> {
  value: V;
  label: string;
}

export interface Industry {
  name: string;
  naicsCodes: string[];
}

/** Include-all, include-any and exclude lists for a collection field. */
export interface TermLists {
  all: string[];
  any: string[];
  exclude: string[];
}

export interface Range {
  min?: number;
  max?: number;
}

export interface WorkforceGrowthState {
  period: GrowthPeriod;
  department: GrowthDepartment;
  /** Minimum growth in percent, e.g. 20 for 20%. The API takes a ratio (0.2). */
  minPercent: number;
}

export interface FilterState {
  countries: Option[];
  regions: Option[];
  states: Option<number>[];
  cities: Option<number>[];
  industries: Industry[];
  employees: EmployeeRange[];
  revenue: RevenueRange[];
  types: CompanyType[];
  categories: Category[];
  categoryMatch: 'all' | 'any';
  technologies: TermLists;
  keywords: TermLists;
  foundedYear: Range;
  fundingRounds: FundingRound[];
  fundingYear: Range;
  /** Disclosed funding in USD. */
  fundingAmount: Range;
  workforceGrowth: WorkforceGrowthState | null;
}

export function emptyFilterState(): FilterState {
  return {
    countries: [],
    regions: [],
    states: [],
    cities: [],
    industries: [],
    employees: [],
    revenue: [],
    types: [],
    categories: [],
    categoryMatch: 'all',
    technologies: { all: [], any: [], exclude: [] },
    keywords: { all: [], any: [], exclude: [] },
    foundedYear: {},
    fundingRounds: [],
    fundingYear: {},
    fundingAmount: {},
    workforceGrowth: null,
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function rangeFilter(range: Range): Range | undefined {
  const out: Range = {};
  if (range.min !== undefined) out.min = range.min;
  if (range.max !== undefined) out.max = range.max;
  return out.min === undefined && out.max === undefined ? undefined : out;
}

type TermRule = string[] | { all?: string[]; in?: string[]; notIn?: string[] };

function termRule(lists: TermLists): TermRule | undefined {
  const all = unique(lists.all);
  const any = unique(lists.any);
  const exclude = unique(lists.exclude);
  if (all.length === 0 && any.length === 0 && exclude.length === 0) return undefined;
  // A plain array already means "requires every value", so keep the simple form when possible.
  if (any.length === 0 && exclude.length === 0) return all;
  const rule: { all?: string[]; in?: string[]; notIn?: string[] } = {};
  if (all.length > 0) rule.all = all;
  if (any.length > 0) rule.in = any;
  if (exclude.length > 0) rule.notIn = exclude;
  return rule;
}

/** Converts builder state to a v2 `CompanySearchFilter`, omitting every empty control. */
export function toApiFilter(state: FilterState): CompanyFilter {
  const filter: CompanyFilter = {};
  if (state.countries.length > 0) filter.country = unique(state.countries.map((c) => c.value));
  if (state.regions.length > 0) filter.region = unique(state.regions.map((r) => r.value));
  if (state.states.length > 0) filter.state = unique(state.states.map((s) => s.value));
  if (state.cities.length > 0) filter.city = unique(state.cities.map((c) => c.value));

  // v2 has no industry filter: an industry is a set of NAICS prefixes, and an array matches any of them.
  const naicsCodes = unique(state.industries.flatMap((i) => i.naicsCodes));
  if (naicsCodes.length > 0) filter.naicsCodes = naicsCodes;

  if (state.employees.length > 0) filter.employees = unique(state.employees);
  if (state.revenue.length > 0) filter.revenue = unique(state.revenue);
  if (state.types.length > 0) filter.type = unique(state.types);

  if (state.categories.length > 0) {
    const categories = unique(state.categories);
    // A plain array requires every category; `in` matches any of them.
    filter.categories = state.categoryMatch === 'any' && categories.length > 1 ? { in: categories } : categories;
  }

  const technologies = termRule(state.technologies);
  if (technologies) filter.technologies = technologies;
  const keywords = termRule(state.keywords);
  if (keywords) filter.keywords = keywords;

  const foundedYear = rangeFilter(state.foundedYear);
  if (foundedYear) filter.foundedYear = foundedYear;
  if (state.fundingRounds.length > 0) filter.fundingRounds = unique(state.fundingRounds);
  const fundingYear = rangeFilter(state.fundingYear);
  if (fundingYear) filter.fundingYear = fundingYear;
  const fundingAmount = rangeFilter(state.fundingAmount);
  if (fundingAmount) filter.fundingAmount = fundingAmount;

  if (state.workforceGrowth) {
    const { period, department, minPercent } = state.workforceGrowth;
    filter.workforceGrowth = { period, department, min: Math.round(minPercent * 100) / 10_000 };
  }
  return filter;
}

interface ParsedRule<T> {
  plain: T[];
  in: T[];
  notIn: T[];
  all: T[];
}

/** Normalises the three accepted value shapes: a value, an array, or `{in, notIn, all}`. */
function parseRule<T>(value: unknown, isValue: (v: unknown) => v is T): ParsedRule<T> {
  const rule: ParsedRule<T> = { plain: [], in: [], notIn: [], all: [] };
  const pick = (list: unknown): T[] => (Array.isArray(list) ? list.filter(isValue) : []);
  if (isValue(value)) rule.plain = [value];
  else if (Array.isArray(value)) rule.plain = pick(value);
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    rule.in = pick(obj.in);
    rule.notIn = pick(obj.notIn);
    rule.all = pick(obj.all);
  }
  return rule;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isOneOf =
  <T extends string>(allowed: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v);

function parseRange(value: unknown): Range {
  if (!value || typeof value !== 'object') return {};
  const { min, max } = value as Record<string, unknown>;
  const range: Range = {};
  if (typeof min === 'number') range.min = min;
  if (typeof max === 'number') range.max = max;
  return range;
}

/** Fields the builder has no control for. They are reported, never silently dropped. */
const UNSUPPORTED_FIELDS = ['query', 'id', 'domain', 'reportedEmployees', 'workforceSize', 'require'] as const;

export interface ImportResult {
  state: FilterState;
  /** Human-readable notes about parts of the filter the builder could not represent. */
  skipped: string[];
}

/**
 * Converts a v2 filter (for example `interpretation.filter` from a semantic count)
 * into builder state. States and cities arrive as ids only, so they are labelled by id.
 */
export function fromApiFilter(filter: CompanyFilter | null | undefined): ImportResult {
  const state = emptyFilterState();
  const skipped: string[] = [];
  if (!filter) return { state, skipped };

  const inclusions = <T>(field: string, rule: ParsedRule<T>): T[] => {
    if (rule.notIn.length > 0) skipped.push(`${field} exclusions`);
    return unique([...rule.plain, ...rule.in, ...rule.all]);
  };

  state.countries = inclusions('country', parseRule(filter.country, isString)).map((code) => ({
    value: code.toUpperCase(),
    label: countryName(code),
  }));
  state.regions = inclusions('region', parseRule(filter.region, isString)).map((id) => ({ value: id, label: regionName(id) }));
  state.states = inclusions('state', parseRule(filter.state, isInteger)).map((id) => ({ value: id, label: `State #${id}` }));
  state.cities = inclusions('city', parseRule(filter.city, isInteger)).map((id) => ({ value: id, label: `City #${id}` }));

  const naicsCodes = inclusions('naicsCodes', parseRule(filter.naicsCodes, isString));
  if (naicsCodes.length > 0) state.industries = [{ name: `NAICS ${naicsCodes.join(', ')}`, naicsCodes }];

  state.employees = inclusions('employees', parseRule(filter.employees, isOneOf(EMPLOYEE_RANGES)));
  state.revenue = inclusions('revenue', parseRule(filter.revenue, isOneOf(REVENUE_RANGES)));
  state.types = inclusions('type', parseRule(filter.type, isOneOf(COMPANY_TYPES)));
  state.fundingRounds = inclusions('fundingRounds', parseRule(filter.fundingRounds, isOneOf(FUNDING_ROUNDS)));

  const categories = parseRule(filter.categories, isOneOf(CATEGORIES));
  if (categories.notIn.length > 0) skipped.push('categories exclusions');
  const required = unique([...categories.plain, ...categories.all]);
  if (required.length === 0 && categories.in.length > 0) {
    state.categories = categories.in;
    state.categoryMatch = 'any';
  } else {
    state.categories = required;
    if (categories.in.length > 0) skipped.push('categories "match any" combined with "match all"');
  }

  const terms = (value: unknown): TermLists => {
    const rule = parseRule(value, isString);
    return { all: unique([...rule.plain, ...rule.all]), any: rule.in, exclude: rule.notIn };
  };
  state.technologies = terms(filter.technologies);
  state.keywords = terms(filter.keywords);

  state.foundedYear = parseRange(filter.foundedYear);
  state.fundingYear = parseRange(filter.fundingYear);
  state.fundingAmount = parseRange(filter.fundingAmount);

  const growth = filter.workforceGrowth;
  if (growth) {
    if (typeof growth.min === 'number') {
      state.workforceGrowth = {
        period: growth.period && isOneOf(GROWTH_PERIODS)(growth.period) ? growth.period : 'y1',
        department: growth.department && isOneOf(GROWTH_DEPARTMENTS)(growth.department) ? growth.department : 'overall',
        minPercent: Math.round(growth.min * 1000) / 10,
      };
    }
    if (typeof growth.max === 'number') skipped.push('workforceGrowth max');
  }

  for (const field of UNSUPPORTED_FIELDS) {
    if (filter[field] !== undefined && filter[field] !== null) skipped.push(field);
  }
  return { state, skipped };
}
