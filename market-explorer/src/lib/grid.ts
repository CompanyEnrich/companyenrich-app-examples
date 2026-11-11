/**
 * Segment heatmap: split the current market by two dimensions and count each
 * cell with the free count endpoint. A segment replaces whatever the base filter
 * says about its own field, so a cell reads "the market, but only this segment".
 */
import { mapWithConcurrency } from './concurrency';
import type { FilterState } from './filter';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  EMPLOYEE_LABELS,
  EMPLOYEE_RANGES,
  FUNDING_ROUND_LABELS,
  FUNDING_ROUNDS,
  REVENUE_LABELS,
  REVENUE_RANGES,
  countryName,
  type Category,
  type CompanyFilter,
  type EmployeeRange,
  type FundingRound,
  type RevenueRange,
} from './options';

export const GRID_DIMENSIONS = ['country', 'employees', 'revenue', 'categories', 'fundingRounds', 'foundedYear'] as const;
export type GridDimension = (typeof GRID_DIMENSIONS)[number];

/** Per axis. 8 x 8 = 64 free count requests at most. */
export const MAX_AXIS_VALUES = 8;
export const GRID_CONCURRENCY = 4;

export const DIMENSION_LABELS: Record<GridDimension, string> = {
  country: 'Country',
  employees: 'Employees',
  revenue: 'Revenue',
  categories: 'Category',
  fundingRounds: 'Funding round',
  foundedYear: 'Founded',
};

interface YearBucket {
  value: string;
  label: string;
  min?: number;
  max?: number;
}

export const FOUNDED_BUCKETS: readonly YearBucket[] = [
  { value: 'before-1990', label: 'Before 1990', max: 1989 },
  { value: '1990-1999', label: '1990s', min: 1990, max: 1999 },
  { value: '2000-2009', label: '2000s', min: 2000, max: 2009 },
  { value: '2010-2014', label: '2010-14', min: 2010, max: 2014 },
  { value: '2015-2019', label: '2015-19', min: 2015, max: 2019 },
  { value: '2020-2022', label: '2020-22', min: 2020, max: 2022 },
  { value: '2023-plus', label: '2023+', min: 2023 },
];

/** Used when the grid splits by country and the filter names no countries. */
export const DEFAULT_GRID_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CA', 'IN', 'NL', 'AU'];

export interface Segment {
  value: string;
  label: string;
}

/** The fixed choices for a dimension. Country is open-ended and returns []. */
export function dimensionOptions(dimension: GridDimension): Segment[] {
  switch (dimension) {
    case 'country':
      return [];
    case 'employees':
      return EMPLOYEE_RANGES.map((value) => ({ value, label: EMPLOYEE_LABELS[value] }));
    case 'revenue':
      return REVENUE_RANGES.map((value) => ({ value, label: REVENUE_LABELS[value] }));
    case 'categories':
      return CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }));
    case 'fundingRounds':
      return FUNDING_ROUNDS.map((value) => ({ value, label: FUNDING_ROUND_LABELS[value] }));
    case 'foundedYear':
      return FOUNDED_BUCKETS.map(({ value, label }) => ({ value, label }));
  }
}

/** Puts fixed-choice values in their natural order (smallest to largest, oldest to newest). */
export function sortSegments(dimension: GridDimension, values: string[]): string[] {
  if (dimension === 'country') return values;
  const order = dimensionOptions(dimension).map((option) => option.value);
  return [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function isValidSegment(dimension: GridDimension, value: string): boolean {
  if (dimension === 'country') return /^[A-Z]{2}$/.test(value);
  return dimensionOptions(dimension).some((option) => option.value === value);
}

export function segmentLabel(dimension: GridDimension, value: string): string {
  if (dimension === 'country') return countryName(value);
  return dimensionOptions(dimension).find((option) => option.value === value)?.label ?? value;
}

function bucket(value: string): YearBucket {
  const found = FOUNDED_BUCKETS.find((b) => b.value === value);
  if (!found) throw new Error(`Unknown founded-year bucket: ${value}`);
  return found;
}

function yearRange({ min, max }: YearBucket): { min?: number; max?: number } {
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
}

/** The base filter narrowed to one segment. The segment replaces that field. */
export function applySegment(filter: CompanyFilter, dimension: GridDimension, value: string): CompanyFilter {
  const next: CompanyFilter = { ...filter };
  switch (dimension) {
    case 'country':
      next.country = [value];
      break;
    case 'employees':
      next.employees = [value as EmployeeRange];
      break;
    case 'revenue':
      next.revenue = [value as RevenueRange];
      break;
    case 'categories':
      next.categories = [value as Category];
      break;
    case 'fundingRounds':
      next.fundingRounds = [value as FundingRound];
      break;
    case 'foundedYear':
      next.foundedYear = yearRange(bucket(value));
      break;
  }
  return next;
}

/** The same narrowing on builder state, used when a heatmap cell is clicked. */
export function applySegmentToState(state: FilterState, dimension: GridDimension, value: string): FilterState {
  switch (dimension) {
    case 'country':
      return { ...state, countries: [{ value, label: countryName(value) }] };
    case 'employees':
      return { ...state, employees: [value as EmployeeRange] };
    case 'revenue':
      return { ...state, revenue: [value as RevenueRange] };
    case 'categories':
      return { ...state, categories: [value as Category], categoryMatch: 'all' };
    case 'fundingRounds':
      return { ...state, fundingRounds: [value as FundingRound] };
    case 'foundedYear':
      return { ...state, foundedYear: yearRange(bucket(value)) };
  }
}

function plainValues(rule: unknown): string[] {
  if (typeof rule === 'string') return [rule];
  if (Array.isArray(rule)) return rule.filter((v): v is string => typeof v === 'string');
  if (rule && typeof rule === 'object') {
    const { in: anyOf = [], all = [] } = rule as { in?: string[]; all?: string[] };
    return [...anyOf, ...all];
  }
  return [];
}

/**
 * Sensible starting values for an axis: what the filter already selects for that
 * field, otherwise the first 8 options.
 */
export function defaultAxisValues(dimension: GridDimension, filter: CompanyFilter): string[] {
  const selected =
    dimension === 'country'
      ? plainValues(filter.country)
      : dimension === 'foundedYear'
        ? []
        : plainValues(filter[dimension]);
  const valid = selected.filter((value) => isValidSegment(dimension, value));
  if (valid.length > 0) return valid.slice(0, MAX_AXIS_VALUES);
  if (dimension === 'country') return DEFAULT_GRID_COUNTRIES.slice(0, MAX_AXIS_VALUES);
  return dimensionOptions(dimension)
    .slice(0, MAX_AXIS_VALUES)
    .map((option) => option.value);
}

export interface AxisSpec {
  dimension: GridDimension;
  values: string[];
}

export interface GridCellSpec {
  row: string;
  column: string;
  filter: CompanyFilter;
}

export function buildGridCells(base: CompanyFilter, rows: AxisSpec, columns: AxisSpec): GridCellSpec[] {
  if (rows.dimension === columns.dimension) throw new Error('Rows and columns must use different dimensions.');
  for (const axis of [rows, columns]) {
    if (axis.values.length === 0 || axis.values.length > MAX_AXIS_VALUES) {
      throw new Error(`Each axis needs 1 to ${MAX_AXIS_VALUES} values.`);
    }
    const invalid = axis.values.find((value) => !isValidSegment(axis.dimension, value));
    if (invalid !== undefined) throw new Error(`"${invalid}" is not a valid ${DIMENSION_LABELS[axis.dimension]} value.`);
  }
  return rows.values.flatMap((row) =>
    columns.values.map((column) => ({
      row,
      column,
      filter: applySegment(applySegment(base, rows.dimension, row), columns.dimension, column),
    })),
  );
}

export interface GridCell {
  row: string;
  column: string;
  count: number | null;
  total: number | null;
  error?: string;
}

export interface GridResult {
  rows: Segment[];
  columns: Segment[];
  cells: GridCell[];
  requests: number;
}

export type CountFn = (filter: CompanyFilter) => Promise<{ count: number; total: number }>;

/** Counts every cell, 4 at a time. A failed cell is reported, not fatal. */
export async function computeGrid(
  base: CompanyFilter,
  rows: AxisSpec,
  columns: AxisSpec,
  count: CountFn,
  concurrency = GRID_CONCURRENCY,
): Promise<GridResult> {
  const specs = buildGridCells(base, rows, columns);
  const cells = await mapWithConcurrency(specs, concurrency, async ({ row, column, filter }): Promise<GridCell> => {
    try {
      const result = await count(filter);
      return { row, column, count: result.count, total: result.total };
    } catch (error) {
      return { row, column, count: null, total: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const label = (axis: AxisSpec) => axis.values.map((value) => ({ value, label: segmentLabel(axis.dimension, value) }));
  return { rows: label(rows), columns: label(columns), cells, requests: specs.length };
}
