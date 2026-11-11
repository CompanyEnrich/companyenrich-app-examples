import { DEPARTMENTS, countOf, type DepartmentKey, type Workforce, type WorkforcePoint } from './departments';

/**
 * Below this many people at the window start a growth rate is too noisy to
 * compare (a team going from 1 to 3 is +200%), so it is shown but not ranked.
 */
export const MIN_GROWTH_BASE = 5;

export type Growth =
  /** Baseline is big enough to compare. `rate` is 0.18 for +18%. */
  | { kind: 'measured'; from: number; to: number; rate: number }
  /** Baseline is 1 to MIN_GROWTH_BASE - 1 people. */
  | { kind: 'small-base'; from: number; to: number; rate: number }
  /** Nobody at the window start, so there is no rate (a new team, or none at all). */
  | { kind: 'zero-base'; from: 0; to: number }
  /** No snapshot at the window start: no history, or history that starts later. */
  | { kind: 'no-history'; firstDate: string | null };

export interface GrowthWindow {
  /** First month of the 12-month window (`historyFrom`). */
  start: string;
  /** Month of the newest snapshot. */
  end: string;
}

export interface CompanyGrowth {
  window: GrowthWindow | null;
  overall: Growth;
  departments: Record<DepartmentKey, Growth>;
}

function day(date: string): string {
  return date.slice(0, 10);
}

/**
 * The snapshot in effect on `date`: the newest point on or before it.
 * `history` holds change points, so a month without a point keeps the
 * previous month's numbers; this is how missing months are filled.
 */
export function pointAt(history: readonly WorkforcePoint[], date: string): WorkforcePoint | undefined {
  let best: WorkforcePoint | undefined;
  for (const point of history) {
    if (day(point.date) > day(date)) continue;
    if (!best || day(point.date) > day(best.date)) best = point;
  }
  return best;
}

export function growthBetween(from: number, to: number, minBase = MIN_GROWTH_BASE): Growth {
  if (from === 0) return { kind: 'zero-base', from: 0, to };
  const rate = (to - from) / from;
  return from >= minBase ? { kind: 'measured', from, to, rate } : { kind: 'small-base', from, to, rate };
}

function everyDepartment(growth: (key: DepartmentKey) => Growth): Record<DepartmentKey, Growth> {
  return Object.fromEntries(DEPARTMENTS.map(({ key }) => [key, growth(key)])) as Record<DepartmentKey, Growth>;
}

/**
 * Growth from `windowStart` (by default the response's own `historyFrom`) to the
 * newest snapshot, overall and per department. Comparing companies needs one
 * shared start; see `buildBenchmark`. The API returns `history` newest first;
 * this does not rely on that order.
 */
export function computeGrowth(
  workforce: Workforce,
  windowStart = workforce.historyFrom,
  minBase = MIN_GROWTH_BASE,
): CompanyGrowth {
  const history = workforce.history ?? [];
  const start = pointAt(history, windowStart);
  const end = history.reduce<WorkforcePoint | undefined>(
    (newest, point) => (!newest || day(point.date) > day(newest.date) ? point : newest),
    undefined,
  );

  if (!start || !end) {
    const firstDate = history.reduce<string | null>(
      (oldest, point) => (oldest === null || day(point.date) < oldest ? day(point.date) : oldest),
      null,
    );
    const missing: Growth = { kind: 'no-history', firstDate };
    return { window: null, overall: missing, departments: everyDepartment(() => missing) };
  }

  return {
    window: { start: day(windowStart), end: day(end.date) },
    overall: growthBetween(start.observedEmployeeCount, end.observedEmployeeCount, minBase),
    departments: everyDepartment((key) =>
      growthBetween(countOf(start.departmentHeadcount, key), countOf(end.departmentHeadcount, key), minBase),
    ),
  };
}

/** The rate, when the growth is solid enough to compare with other companies. */
export function comparableRate(growth: Growth | null | undefined): number | null {
  return growth?.kind === 'measured' ? growth.rate : null;
}
