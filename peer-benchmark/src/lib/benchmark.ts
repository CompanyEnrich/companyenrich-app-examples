import { DEPARTMENTS, type DepartmentKey, type Workforce } from './departments';
import { comparableRate, computeGrowth, type CompanyGrowth, type Growth, type GrowthWindow } from './growth';
import { departmentMix, type DepartmentMix } from './mix';
import { median, percentileRank, type PercentileRank } from './stats';

export type Role = 'subject' | 'peer';

export interface CompanyRef {
  domain: string;
  name: string;
  role: Role;
}

/** What the server learned about one company: workforce data, or why it is left out. */
export type CompanyOutcome =
  | (CompanyRef & { status: 'ok'; workforce: Workforce })
  | (CompanyRef & { status: 'excluded'; reason: string });

export interface CompanyRow extends CompanyRef {
  mix: DepartmentMix;
  growth: CompanyGrowth;
}

export interface ExcludedCompany extends CompanyRef {
  /** Lower-case fragment, e.g. "no workforce data for this domain". */
  reason: string;
}

export interface PeerPoint {
  domain: string;
  name: string;
  value: number;
}

/** The subject's value for one metric against every peer that has a value. */
export interface Comparison {
  subject: number | null;
  peerMedian: number | null;
  peers: PeerPoint[];
  /** Where the subject sits among those peers. */
  rank: PercentileRank | null;
}

export interface DepartmentBenchmark {
  key: DepartmentKey;
  label: string;
  team: string;
  /** Share of observed headcount. `ratio` is subject / peer median, null when the median is 0. */
  share: Comparison & { ratio: number | null };
  /** Window growth. Only baselines of MIN_GROWTH_BASE or more people are compared. */
  growth: Comparison & { subjectGrowth: Growth | null };
}

export interface Benchmark {
  subject: CompanyRow | null;
  /** Peers with usable data, in the order they were picked. */
  peers: CompanyRow[];
  excluded: ExcludedCompany[];
  window: GrowthWindow | null;
  headcount: Comparison;
  growth: Comparison & { subjectGrowth: Growth | null };
  unclassified: Comparison;
  departments: DepartmentBenchmark[];
}

function compare(subject: number | null, peers: PeerPoint[]): Comparison {
  const values = peers.map((peer) => peer.value);
  return {
    subject,
    peerMedian: median(values),
    peers,
    rank: subject === null ? null : percentileRank(subject, values),
  };
}

function pointsFor(peers: readonly CompanyRow[], value: (row: CompanyRow) => number | null): PeerPoint[] {
  return peers.flatMap((row) => {
    const result = value(row);
    return result === null ? [] : [{ domain: row.domain, name: row.name, value: result }];
  });
}

/**
 * Every row is measured from the common start. History holds change points, so
 * a company whose last change was in October still has that value in November;
 * the group's window ends at the newest snapshot anyone has.
 */
function sharedWindow(rows: readonly CompanyRow[]): GrowthWindow | null {
  const windows = rows.flatMap((row) => (row.growth.window ? [row.growth.window] : []));
  const first = windows[0];
  if (!first) return null;
  return { start: first.start, end: windows.reduce((latest, candidate) => (candidate.end > latest ? candidate.end : latest), first.end) };
}

/**
 * The window start every company is measured from: the latest `historyFrom`.
 * Responses fetched in different months (a cached one from 31 October next to
 * a fresh one from 1 November) start a month apart; measuring each from its own
 * start would compare growth over different periods.
 */
export function commonWindowStart(workforces: readonly Workforce[]): string | null {
  return workforces.reduce<string | null>((latest, workforce) => {
    const start = workforce.historyFrom.slice(0, 10);
    return latest === null || start > latest ? start : latest;
  }, null);
}

export function buildBenchmark(outcomes: readonly CompanyOutcome[]): Benchmark {
  const usable: (CompanyRef & { workforce: Workforce; mix: DepartmentMix })[] = [];
  const excluded: ExcludedCompany[] = [];

  for (const outcome of outcomes) {
    const ref: CompanyRef = { domain: outcome.domain, name: outcome.name, role: outcome.role };
    if (outcome.status === 'excluded') {
      excluded.push({ ...ref, reason: outcome.reason });
      continue;
    }
    const mix = departmentMix(outcome.workforce);
    if (!mix) {
      excluded.push({ ...ref, reason: 'no observed employees in the people dataset' });
      continue;
    }
    usable.push({ ...ref, workforce: outcome.workforce, mix });
  }

  // A company with no snapshot at or before the common start gets "no history" and is not compared.
  const windowStart = commonWindowStart(usable.map((company) => company.workforce));
  const rows: CompanyRow[] = usable.map(({ workforce, ...company }) => ({
    ...company,
    growth: computeGrowth(workforce, windowStart ?? workforce.historyFrom),
  }));

  const subject = rows.find((row) => row.role === 'subject') ?? null;
  const peers = rows.filter((row) => row.role === 'peer');

  const departments = DEPARTMENTS.map(({ key, label, team }): DepartmentBenchmark => {
    const share = compare(subject ? subject.mix.shares[key] : null, pointsFor(peers, (row) => row.mix.shares[key]));
    const ratio =
      share.subject !== null && share.peerMedian !== null && share.peerMedian > 0
        ? share.subject / share.peerMedian
        : null;
    const subjectGrowth = subject ? subject.growth.departments[key] : null;
    const growth = compare(
      comparableRate(subjectGrowth),
      pointsFor(peers, (row) => comparableRate(row.growth.departments[key])),
    );
    return { key, label, team, share: { ...share, ratio }, growth: { ...growth, subjectGrowth } };
  });

  return {
    subject,
    peers,
    excluded,
    window: sharedWindow(rows),
    headcount: compare(subject?.mix.observed ?? null, pointsFor(peers, (row) => row.mix.observed)),
    growth: {
      ...compare(comparableRate(subject?.growth.overall), pointsFor(peers, (row) => comparableRate(row.growth.overall))),
      subjectGrowth: subject?.growth.overall ?? null,
    },
    unclassified: compare(subject?.mix.unclassifiedShare ?? null, pointsFor(peers, (row) => row.mix.unclassifiedShare)),
    departments,
  };
}

/** Departments worth a row in the mix chart: anyone in the group has at least `minShare` there. */
export function departmentsForMix(benchmark: Benchmark, minShare = 0.01): DepartmentBenchmark[] {
  const visible = benchmark.departments.filter((department) => {
    const values = [department.share.subject ?? 0, ...department.share.peers.map((peer) => peer.value)];
    return Math.max(...values) >= minShare;
  });
  // Biggest departments first, by the peer median and then the subject's own share.
  return visible.sort(
    (a, b) =>
      (b.share.peerMedian ?? 0) - (a.share.peerMedian ?? 0) || (b.share.subject ?? 0) - (a.share.subject ?? 0),
  );
}

/** Departments with at least one comparable growth rate, in the same order as the mix chart. */
export function departmentsForGrowth(benchmark: Benchmark): DepartmentBenchmark[] {
  return departmentsForMix(benchmark, 0).filter(
    (department) => department.growth.subject !== null || department.growth.peers.length > 0,
  );
}
