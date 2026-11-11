import type { Category, CompanyFilter, EmployeeRange } from './types.js';

export const EMPLOYEE_RANGES: readonly EmployeeRange[] = ['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K'];
export const CATEGORIES: readonly Category[] = ['b2b', 'b2c', 'b2g', 'e-commerce', 'media', 'service-provider', 'mobile', 'saas', 'local-business'];

/** Large markets used for the country breakdown when --country is not given. */
export const DEFAULT_BREAKDOWN_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'NL', 'IN', 'ES', 'BR'];

/** Who to target: companies running `competitor`, not running `mine`, narrowed by firmographics. */
export interface TargetSpec {
  competitor: string;
  mine?: string | undefined;
  countries: string[];
  employees: EmployeeRange[];
  categories: Category[];
  /** Domains bought in earlier runs (--exclude), left out of every count and search. */
  exclude: string[];
}

/** `all` requires the competitor's technology; `notIn` drops anyone already running yours. */
export function technologyRule(competitor: string, mine?: string): NonNullable<CompanyFilter['technologies']> {
  return mine ? { all: [competitor], notIn: [mine] } : { all: [competitor] };
}

/** The displacement market: every filter except the why-now signals. */
export function buildTargetFilter(spec: TargetSpec): CompanyFilter {
  const filter: CompanyFilter = { technologies: technologyRule(spec.competitor, spec.mine) };
  if (spec.countries.length > 0) filter.country = spec.countries;
  if (spec.employees.length > 0) filter.employees = spec.employees;
  // A plain array would require every category; `in` matches companies in any of them.
  if (spec.categories.length > 0) filter.categories = { in: spec.categories };
  return excludeDomains(filter, spec.exclude);
}

/**
 * Adds domains to `domain: {notIn}`, keeping any already there, so a paid search never returns
 * (and never bills) a company twice.
 */
export function excludeDomains(filter: CompanyFilter, domains: readonly string[]): CompanyFilter {
  if (domains.length === 0) return filter;
  const rule = filter.domain;
  const existing = rule && typeof rule === 'object' && !Array.isArray(rule) ? (rule.notIn ?? []) : [];
  return { ...filter, domain: { notIn: [...new Set([...existing, ...domains])] } };
}
