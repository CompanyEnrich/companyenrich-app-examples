import type { Benchmark, Comparison, CompanyRow, DepartmentBenchmark } from './benchmark';
import { formatChange, formatCount, formatGrowth, formatMonth, formatRatio, formatShare, possessive } from './format';
import { MIN_GROWTH_BASE, type Growth } from './growth';

/** Departments under this share on both sides are too small to call out. */
const MIN_NOTABLE_SHARE = 0.03;
/** Subject share / peer median at or above this is "over-indexed"; at or below UNDER_INDEX, "under-indexed". */
const OVER_INDEX = 1.25;
const UNDER_INDEX = 0.75;
/** Department growth must differ from the peer median by this much (10 points) to be called out. */
const MIN_GROWTH_GAP = 0.1;
/** Unclassified shares this far apart change how the department shares read. */
const UNCLASSIFIED_GAP = 0.1;

const MAX_OVER_INDEXED = 2;
const MAX_UNDER_INDEXED = 2;
const MAX_FASTER_GROWING = 2;
const MAX_SLOWER_GROWING = 1;

/**
 * Plain-English findings, always in the same order and wording for the same
 * data: size, overall growth, department mix outliers, department growth
 * outliers, a data-quality note, and what was excluded.
 */
export function buildInsights(benchmark: Benchmark): string[] {
  const { subject, peers } = benchmark;
  const insights: string[] = [];

  if (!subject) {
    const missing = benchmark.excluded.find((company) => company.role === 'subject');
    insights.push(
      `There is no workforce data for ${missing?.name ?? 'the selected company'}, so there is nothing to compare. Try another domain for the same company.`,
    );
  } else if (peers.length === 0) {
    insights.push(`None of the peers has workforce data, so ${subject.name} cannot be compared. Pick different peers.`);
  } else {
    insights.push(headcountInsight(subject, benchmark.headcount));
    insights.push(growthInsight(subject, benchmark));
    insights.push(...mixInsights(subject, benchmark.departments));
    insights.push(...departmentGrowthInsights(subject, benchmark));
    const unclassified = unclassifiedInsight(subject, benchmark.unclassified);
    if (unclassified) insights.push(unclassified);
  }

  const excluded = benchmark.excluded.filter((company) => company.role === 'peer');
  if (excluded.length > 0) {
    const list = excluded.map((company) => `${company.domain} (${company.reason})`).join(', ');
    insights.push(`Excluded from the peer group: ${list}.`);
  }
  return insights;
}

function headcountInsight(subject: CompanyRow, headcount: Comparison): string {
  const rank = headcount.rank;
  let position = '';
  if (rank && rank.below === rank.total) position = ', the most in the group';
  else if (rank && rank.below === 0 && rank.tied === 0) position = ', the fewest in the group';
  else if (rank) position = `, more than ${rank.below} of ${rank.total} peers`;
  const median = headcount.peerMedian === null ? '' : ` (peer median ${formatCount(headcount.peerMedian)})`;
  return `${subject.name} has ${formatCount(subject.mix.observed)} observed employees${position}${median}.`;
}

function changeVerb(rate: number): string {
  if (Math.abs(rate) < 0.005) return 'held flat';
  return rate > 0 ? `grew ${formatChange(rate)}` : `shrank ${formatChange(rate)}`;
}

function notComparableReason(growth: Growth, since: string): string {
  switch (growth.kind) {
    case 'no-history':
      return growth.firstDate
        ? `its history only starts in ${formatMonth(growth.firstDate)}`
        : 'it has no workforce history';
    case 'zero-base':
      return `it had no observed employees in ${since}`;
    case 'small-base':
      return `it had fewer than ${MIN_GROWTH_BASE} observed employees in ${since}`;
    case 'measured':
      return '';
  }
}

function growthInsight(subject: CompanyRow, benchmark: Benchmark): string {
  const growth = subject.growth.overall;
  const since = benchmark.window ? formatMonth(benchmark.window.start) : 'the start of the window';
  if (growth.kind !== 'measured') {
    return `Growth for ${subject.name} is not compared because ${notComparableReason(growth, since)}.`;
  }
  const peerMedian = benchmark.growth.peerMedian;
  const versus =
    peerMedian === null ? '; no peer has comparable history' : ` vs a peer median of ${formatGrowth(peerMedian)}`;
  return `Observed headcount at ${subject.name} ${changeVerb(growth.rate)} since ${since} (${formatCount(growth.from)} → ${formatCount(growth.to)})${versus}.`;
}

function extremeSuffix(department: DepartmentBenchmark): string {
  const rank = department.share.rank;
  if (!rank || rank.total < 2) return '';
  if (rank.below === rank.total) return ', the highest in the group';
  if (rank.below === 0 && rank.tied === 0) return ', the lowest in the group';
  return '';
}

interface Candidate {
  /** How much the difference matters; the biggest are reported first. */
  weight: number;
  text: string;
}

/** Array.prototype.sort is stable, so equal weights keep the fixed department order. */
function strongest(candidates: Candidate[], count: number): string[] {
  return candidates
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count)
    .map((candidate) => candidate.text);
}

/**
 * Departments whose share is far from the peer median. A ratio qualifies a
 * department, but ranking by the gap in percentage points keeps a 1-person
 * finance team (0.6% vs 5%) from outranking engineering at 50% vs 36%.
 */
function mixInsights(subject: CompanyRow, departments: readonly DepartmentBenchmark[]): string[] {
  const over: Candidate[] = [];
  const under: Candidate[] = [];
  const owner = possessive(subject.name);

  for (const department of departments) {
    const share = department.share.subject;
    const median = department.share.peerMedian;
    const ratio = department.share.ratio;
    if (share === null || median === null) continue;
    const weight = Math.abs(share - median);
    const versus = `(${formatShare(share)} of observed headcount vs ${formatShare(median)})${extremeSuffix(department)}`;

    if (share >= MIN_NOTABLE_SHARE && median === 0) {
      over.push({ weight, text: `${owner} ${department.team} is ${formatShare(share)} of observed headcount, while the peer median is 0%.` });
    } else if (share >= MIN_NOTABLE_SHARE && ratio !== null && ratio >= OVER_INDEX) {
      over.push({ weight, text: `${owner} ${department.team} is ${formatRatio(ratio)} the peer median share ${versus}.` });
    } else if (median >= MIN_NOTABLE_SHARE && share === 0) {
      under.push({ weight, text: `${subject.name} has no observed ${department.team}, while the peer median share is ${formatShare(median)}.` });
    } else if (median >= MIN_NOTABLE_SHARE && ratio !== null && ratio <= UNDER_INDEX) {
      under.push({ weight, text: `${owner} ${department.team} is ${formatRatio(ratio)} the peer median share ${versus}.` });
    }
  }

  return [...strongest(over, MAX_OVER_INDEXED), ...strongest(under, MAX_UNDER_INDEXED)];
}

/**
 * Departments growing much faster or slower than the peer median. Weighting the
 * gap by the starting headcount ranks "about 19 more engineers than the peer
 * rate implies" above a marketing team that went from 7 to 12.
 */
function departmentGrowthInsights(subject: CompanyRow, benchmark: Benchmark): string[] {
  const since = benchmark.window ? formatMonth(benchmark.window.start) : 'the start of the window';
  const faster: Candidate[] = [];
  const slower: Candidate[] = [];

  for (const department of benchmark.departments) {
    const { subjectGrowth: growth, peerMedian, peers } = department.growth;
    // One peer is an anecdote, not a median.
    if (growth?.kind !== 'measured' || peerMedian === null || peers.length < 2) continue;
    const gap = growth.rate - peerMedian;
    const candidate = {
      weight: Math.abs(gap) * growth.from,
      text: `${possessive(subject.name)} ${department.team} ${changeVerb(growth.rate)} since ${since} (${formatCount(growth.from)} → ${formatCount(growth.to)}) vs a peer median of ${formatGrowth(peerMedian)}.`,
    };
    if (gap >= MIN_GROWTH_GAP) faster.push(candidate);
    else if (gap <= -MIN_GROWTH_GAP) slower.push(candidate);
  }

  return [...strongest(faster, MAX_FASTER_GROWING), ...strongest(slower, MAX_SLOWER_GROWING)];
}

function unclassifiedInsight(subject: CompanyRow, unclassified: Comparison): string | null {
  const share = unclassified.subject;
  const median = unclassified.peerMedian;
  if (share === null || median === null) return null;
  if (share - median >= UNCLASSIFIED_GAP) {
    return `${formatShare(share)} of ${possessive(subject.name)} observed headcount has no department from job titles (peer median ${formatShare(median)}), so its department shares read lower than the peers'.`;
  }
  if (median - share >= UNCLASSIFIED_GAP) {
    return `Peers have more observed headcount with no department from job titles (median ${formatShare(median)} vs ${formatShare(share)} at ${subject.name}), so their department shares read lower than ${possessive(subject.name)}.`;
  }
  return null;
}
