import type { Company } from './types.js';

export type EmployeeRange = NonNullable<Company['employees']>;
export type RevenueRange = NonNullable<Company['revenue']>;

export const DIMENSIONS = ['industry', 'categories', 'employees', 'revenue', 'country', 'foundedYear', 'technologies'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

// Range-like values in their natural order, smallest first.
export const EMPLOYEE_RANGES: readonly EmployeeRange[] = ['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K'];
export const REVENUE_RANGES: readonly RevenueRange[] = ['under-1m', '1m-10m', '10m-50m', '50m-100m', '100m-200m', '200m-1b', 'over-1b'];

/** Founded years are bucketed by decade: 2015 -> "2010s". */
export function foundedDecade(year: number): string {
  return `${Math.floor(year / 10) * 10}s`;
}

/**
 * The values a company has for one dimension. Industry, categories and technologies can hold several
 * values, so one company can count toward several rows of the same table.
 */
export function valuesOf(company: Company, dimension: Dimension): string[] {
  switch (dimension) {
    case 'industry':
      // `industries` lists every industry the company is associated with; `industry` is only the primary one.
      return company.industries?.length ? company.industries : company.industry ? [company.industry] : [];
    case 'categories':
      return company.categories ?? [];
    case 'employees':
      return company.employees ? [company.employees] : [];
    case 'revenue':
      return company.revenue ? [company.revenue] : [];
    case 'country':
      return company.location?.country?.code ? [company.location.country.code] : [];
    case 'foundedYear':
      return company.foundedYear ? [foundedDecade(company.foundedYear)] : [];
    case 'technologies':
      return company.technologies ?? [];
  }
}

export interface ValueShare {
  value: string;
  customers: number;
  /** customers / all profiled customers, so values without data lower every share. */
  share: number;
}

export interface Profile {
  customers: number;
  dimensions: Record<Dimension, ValueShare[]>;
  /** Customers with no value for the dimension. */
  unknown: Record<Dimension, number>;
}

const NATURAL_ORDER: Partial<Record<Dimension, readonly string[]>> = {
  employees: EMPLOYEE_RANGES,
  revenue: REVENUE_RANGES,
};

function sortShares(dimension: Dimension, shares: ValueShare[]): ValueShare[] {
  const order = NATURAL_ORDER[dimension];
  if (order) return shares.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  if (dimension === 'foundedYear') return shares.sort((a, b) => a.value.localeCompare(b.value));
  return shares.sort((a, b) => b.customers - a.customers || a.value.localeCompare(b.value));
}

export function buildProfile(companies: readonly Company[]): Profile {
  const total = companies.length;
  const dimensions = {} as Record<Dimension, ValueShare[]>;
  const unknown = {} as Record<Dimension, number>;

  for (const dimension of DIMENSIONS) {
    const counts = new Map<string, number>();
    unknown[dimension] = 0;
    for (const company of companies) {
      const values = new Set(valuesOf(company, dimension));
      if (values.size === 0) unknown[dimension]++;
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const shares = [...counts].map(([value, customers]) => ({ value, customers, share: customers / total }));
    dimensions[dimension] = sortShares(dimension, shares);
  }
  return { customers: total, dimensions, unknown };
}
