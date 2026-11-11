import type { CompanySearchQuery } from '@companyenrich/sdk';

/** The v2 company search filter, exactly as the SDK types it. */
export type CompanyFilter = NonNullable<CompanySearchQuery['filter']>;

type EnumOf<T> = Extract<NonNullable<T>, string>;

export type EmployeeRange = EnumOf<CompanyFilter['employees']>;
export type RevenueRange = EnumOf<CompanyFilter['revenue']>;
export type Category = EnumOf<CompanyFilter['categories']>;
export type CompanyType = EnumOf<CompanyFilter['type']>;
export type FundingRound = EnumOf<CompanyFilter['fundingRounds']>;
export type GrowthPeriod = NonNullable<NonNullable<CompanyFilter['workforceGrowth']>['period']>;
export type GrowthDepartment = NonNullable<NonNullable<CompanyFilter['workforceGrowth']>['department']>;

// `satisfies` makes the compiler reject any value the API does not accept.
export const EMPLOYEE_RANGES = [
  '1-10',
  '11-50',
  '51-200',
  '201-500',
  '501-1K',
  '1K-5K',
  '5K-10K',
  'over-10K',
] as const satisfies readonly EmployeeRange[];

export const REVENUE_RANGES = [
  'under-1m',
  '1m-10m',
  '10m-50m',
  '50m-100m',
  '100m-200m',
  '200m-1b',
  'over-1b',
] as const satisfies readonly RevenueRange[];

export const CATEGORIES = [
  'b2b',
  'b2c',
  'b2g',
  'saas',
  'e-commerce',
  'service-provider',
  'media',
  'mobile',
  'local-business',
] as const satisfies readonly Category[];

export const COMPANY_TYPES = [
  'private',
  'public',
  'nonprofit',
  'educational',
  'government',
  'partnership',
  'self-employed',
  'self-owned',
] as const satisfies readonly CompanyType[];

export const FUNDING_ROUNDS = [
  'angel',
  'seed',
  'series_a',
  'series_b',
  'series_c',
  'series_d',
  'series_e',
  'series_f',
  'series_g',
  'series_h',
  'venture',
  'debt_financing',
  'other',
] as const satisfies readonly FundingRound[];

export const GROWTH_PERIODS = ['m6', 'y1', 'y2'] as const satisfies readonly GrowthPeriod[];

export const GROWTH_DEPARTMENTS = [
  'overall',
  'engineering_technical',
  'sales',
  'marketing',
  'product_management',
  'operations',
  'finance',
  'human_resources',
  'information_technology',
  'design',
  'legal',
  'consulting',
  'c_suite',
  'education',
  'medical_health',
] as const satisfies readonly GrowthDepartment[];

export const EMPLOYEE_LABELS: Record<EmployeeRange, string> = {
  '1-10': '1-10',
  '11-50': '11-50',
  '51-200': '51-200',
  '201-500': '201-500',
  '501-1K': '501-1K',
  '1K-5K': '1K-5K',
  '5K-10K': '5K-10K',
  'over-10K': '10K+',
};

export const REVENUE_LABELS: Record<RevenueRange, string> = {
  'under-1m': '< $1M',
  '1m-10m': '$1M-10M',
  '10m-50m': '$10M-50M',
  '50m-100m': '$50M-100M',
  '100m-200m': '$100M-200M',
  '200m-1b': '$200M-1B',
  'over-1b': '> $1B',
};

export const CATEGORY_LABELS: Record<Category, string> = {
  b2b: 'B2B',
  b2c: 'B2C',
  b2g: 'B2G',
  saas: 'SaaS',
  'e-commerce': 'E-commerce',
  'service-provider': 'Service provider',
  media: 'Media',
  mobile: 'Mobile',
  'local-business': 'Local business',
};

export const TYPE_LABELS: Record<CompanyType, string> = {
  private: 'Private',
  public: 'Public',
  nonprofit: 'Nonprofit',
  educational: 'Educational',
  government: 'Government',
  partnership: 'Partnership',
  'self-employed': 'Self-employed',
  'self-owned': 'Self-owned',
};

export const FUNDING_ROUND_LABELS: Record<FundingRound, string> = {
  angel: 'Angel',
  seed: 'Seed',
  series_a: 'Series A',
  series_b: 'Series B',
  series_c: 'Series C',
  series_d: 'Series D',
  series_e: 'Series E',
  series_f: 'Series F',
  series_g: 'Series G',
  series_h: 'Series H',
  venture: 'Venture (unlabelled)',
  debt_financing: 'Debt financing',
  other: 'Other',
};

export const GROWTH_PERIOD_LABELS: Record<GrowthPeriod, string> = {
  m6: 'last 6 months',
  y1: 'last 12 months',
  y2: 'last 24 months',
};

export const GROWTH_DEPARTMENT_LABELS: Record<GrowthDepartment, string> = {
  overall: 'Whole company',
  engineering_technical: 'Engineering',
  sales: 'Sales',
  marketing: 'Marketing',
  product_management: 'Product',
  operations: 'Operations',
  finance: 'Finance',
  human_resources: 'HR',
  information_technology: 'IT',
  design: 'Design',
  legal: 'Legal',
  consulting: 'Consulting',
  c_suite: 'C-suite',
  education: 'Education',
  medical_health: 'Medical & health',
};

const countryNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });

/** English country name for an ISO 3166-1 alpha-2 code, without an API call. */
export function countryName(code: string): string {
  try {
    return countryNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** "Europe/Western Europe" -> "Western Europe". Region ids are paths. */
export function regionName(id: string): string {
  return id.split('/').pop() ?? id;
}
