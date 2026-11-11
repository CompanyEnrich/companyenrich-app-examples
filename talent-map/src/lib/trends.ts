import type { CompanyWorkforce } from '@companyenrich/sdk';
import type { HeadcountKey } from './types.js';

/** Changes smaller than this share of the baseline are shown as flat. */
export const FLAT_THRESHOLD = 0.05;

export interface TeamTrend {
  /** Observed headcount today for the role's department(s), or the whole company. */
  headcount: number;
  /** Headcount at the oldest point of the 12-month window, and that point's month. */
  baseline?: { headcount: number; date: string };
  change?: number;
  /** change / baseline; omitted when the baseline is 0. */
  changePct?: number;
  direction?: 'up' | 'down' | 'flat';
}

type Snapshot = Pick<CompanyWorkforce, 'observedEmployeeCount' | 'departmentHeadcount'>;

function headcountOf(snapshot: Snapshot, keys: readonly HeadcountKey[]): number {
  if (keys.length === 0) return snapshot.observedEmployeeCount;
  // Departments with no observed people are omitted from the response, so a missing key is 0.
  return keys.reduce((sum, key) => sum + (snapshot.departmentHeadcount[key] ?? 0), 0);
}

/**
 * The 12-month trend for a team. `history` is newest first, so its last point is the baseline;
 * the API carries the last known headcount forward into that first month when it has one.
 */
export function teamTrend(workforce: CompanyWorkforce, keys: readonly HeadcountKey[]): TeamTrend {
  const headcount = headcountOf(workforce, keys);
  const oldest = workforce.history?.at(-1);
  if (!oldest) return { headcount };

  const baseline = headcountOf(oldest, keys);
  const change = headcount - baseline;
  const changePct = baseline > 0 ? change / baseline : undefined;
  const flat = change === 0 || (changePct !== undefined && Math.abs(changePct) < FLAT_THRESHOLD);
  return {
    headcount,
    baseline: { headcount: baseline, date: oldest.date },
    change,
    ...(changePct !== undefined ? { changePct } : {}),
    direction: flat ? 'flat' : change > 0 ? 'up' : 'down',
  };
}

const ARROWS = { up: '▲', down: '▼', flat: '▶' } as const;

export interface TrendText {
  arrow: string;
  /** Signed change, e.g. "+12 (+8%)" or "−3 (−5%)". */
  change: string;
  /** e.g. "since Dec 2025: 300 → 312". */
  since: string;
}

/** Display text for a trend, or undefined when there is no history to compare against. */
export function describeTrend(trend: TeamTrend): TrendText | undefined {
  if (!trend.baseline || trend.change === undefined || !trend.direction) return undefined;
  const sign = trend.change > 0 ? '+' : trend.change < 0 ? '−' : '±';
  const pct = trend.changePct === undefined ? '' : ` (${sign}${Math.round(Math.abs(trend.changePct) * 100)}%)`;
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(trend.baseline.date));
  const count = (value: number) => value.toLocaleString('en-US');
  return {
    arrow: ARROWS[trend.direction],
    change: `${sign}${count(Math.abs(trend.change))}${pct}`,
    since: `since ${month}: ${count(trend.baseline.headcount)} → ${count(trend.headcount)}`,
  };
}
