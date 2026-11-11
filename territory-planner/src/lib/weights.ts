import {
  EMPLOYEE_RANGES,
  REVENUE_RANGES,
  selectedBands,
  type CompanyFilter,
  type EmployeeRange,
  type RevenueRange,
} from './icp.js';

export const WEIGHT_MODES = ['none', 'revenue', 'employees'] as const;
export type WeightBy = (typeof WEIGHT_MODES)[number];

/**
 * Midpoint of each employee band: (low + high) / 2. The open-ended top band uses 1.5x its lower bound.
 * The weight of a state is "estimated headcount at ICP companies", a proxy for seat-based deal size.
 */
export const EMPLOYEE_MIDPOINTS: Record<EmployeeRange, number> = {
  '1-10': 5.5,
  '11-50': 30.5,
  '51-200': 125.5,
  '201-500': 350.5,
  '501-1K': 750.5,
  '1K-5K': 3_000,
  '5K-10K': 7_500,
  'over-10K': 15_000,
};

/** Midpoint of each revenue band in USD millions, same rule. The bottom band runs from 0 to 1. */
export const REVENUE_MIDPOINTS_USD_M: Record<RevenueRange, number> = {
  'under-1m': 0.5,
  '1m-10m': 5.5,
  '10m-50m': 30,
  '50m-100m': 75,
  '100m-200m': 150,
  '200m-1b': 600,
  'over-1b': 1_500,
};

/** How to weight companies: which filter field holds the bands and what each band is worth. */
export interface BandScheme {
  mode: Exclude<WeightBy, 'none'>;
  field: 'employees' | 'revenue';
  /** The bands to count, already narrowed to the ones the ICP allows. */
  bands: string[];
  midpoints: Record<string, number>;
}

/** Returns the band scheme for a weighting mode, or null when balancing on plain company counts. */
export function bandScheme(mode: WeightBy, icp: CompanyFilter): BandScheme | null {
  if (mode === 'employees') {
    return {
      mode,
      field: 'employees',
      bands: selectedBands(icp.employees, EMPLOYEE_RANGES),
      midpoints: EMPLOYEE_MIDPOINTS,
    };
  }
  if (mode === 'revenue') {
    return {
      mode,
      field: 'revenue',
      bands: selectedBands(icp.revenue, REVENUE_RANGES),
      midpoints: REVENUE_MIDPOINTS_USD_M,
    };
  }
  return null;
}

/** Free counts for one state: all ICP companies, plus one count per band when weighting. */
export interface StateCounts {
  companies: number;
  bands: Record<string, number>;
}

export interface WeightResult {
  /** Weighted value per state, in input order. Equals `companies` when not weighting. */
  weights: number[];
  /** Companies that fell in one of the counted bands, across all states. */
  bandedCompanies: number;
  /** The midpoint used for companies with no band on file: the country-wide average of banded companies. */
  fallbackMidpoint: number;
}

/**
 * Weighted value of each state: sum of (band count x band midpoint), plus companies with no band
 * on file (for example no revenue estimate) at the country-wide average midpoint, so a state with
 * thin band coverage is not under-weighted.
 */
export function weightStates(states: StateCounts[], scheme: BandScheme | null): WeightResult {
  if (!scheme) {
    const weights = states.map((state) => state.companies);
    return { weights, bandedCompanies: weights.reduce((sum, value) => sum + value, 0), fallbackMidpoint: 1 };
  }
  let bandedCompanies = 0;
  let bandedWeight = 0;
  for (const state of states) {
    for (const band of scheme.bands) {
      const count = state.bands[band] ?? 0;
      bandedCompanies += count;
      bandedWeight += count * (scheme.midpoints[band] ?? 0);
    }
  }
  const fallbackMidpoint = bandedCompanies > 0 ? bandedWeight / bandedCompanies : 0;
  const weights = states.map((state) => {
    let banded = 0;
    let weight = 0;
    for (const band of scheme.bands) {
      const count = state.bands[band] ?? 0;
      banded += count;
      weight += count * (scheme.midpoints[band] ?? 0);
    }
    const unbanded = Math.max(0, state.companies - banded);
    return weight + unbanded * fallbackMidpoint;
  });
  return { weights, bandedCompanies, fallbackMidpoint };
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const small = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Formats a weighted value for display: "12,345" companies, "1.2M" employees or "$3.4B" revenue. */
export function formatWeight(value: number, mode: WeightBy): string {
  if (mode === 'revenue') return `$${compact.format(value * 1_000_000)}`;
  if (mode === 'employees') return compact.format(value);
  // Company totals are whole numbers; a spread such as a standard deviation can be below 1.
  return (Math.abs(value) < 100 ? small : whole).format(value);
}
