import type { Balance } from './partition.js';
import type { PlanReport, Territory, TerritoryState } from './planner.js';
import { formatWeight } from './weights.js';

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatInt(value: number): string {
  return integer.format(value);
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatSignedPercent(fraction: number): string {
  const text = formatPercent(Math.abs(fraction));
  if (text === formatPercent(0)) return text;
  return `${fraction > 0 ? '+' : '-'}${text}`;
}

/** What the plan balances, as a column heading. */
export function weightLabel(report: PlanReport): string {
  if (report.weightBy === 'employees') return 'Est. employees';
  if (report.weightBy === 'revenue') return 'Est. revenue';
  return 'ICP companies';
}

/** What the plan balances, inside a sentence: "Balance on ICP companies: ...". */
export function balanceBasis(report: PlanReport): string {
  if (report.weightBy === 'employees') return 'estimated employees';
  if (report.weightBy === 'revenue') return 'estimated revenue';
  return 'ICP companies';
}

export function formatReportWeight(report: PlanReport, value: number): string {
  return formatWeight(value, report.weightBy);
}

export function stateLabel(state: TerritoryState): string {
  return state.code ?? state.name;
}

export function territoryName(territory: Territory): string {
  return territory.rep ? `Territory ${territory.number} (${territory.rep})` : `Territory ${territory.number}`;
}

/** "max/min 1.004, std dev 9.8 (0.4% of the mean)", in the units the plan balances. */
export function describeBalance(report: PlanReport, balance: Balance = report.balance): string {
  const ratio = balance.maxMinRatio === null ? 'n/a (a territory is empty)' : balance.maxMinRatio.toFixed(3);
  const spread = formatReportWeight(report, balance.stdDev);
  return `max/min ${ratio}, std dev ${spread} (${formatPercent(balance.coefficientOfVariation)} of the mean)`;
}

export function placedShare(report: PlanReport): number {
  return report.coverage.countryTotal > 0 ? report.coverage.placed / report.coverage.countryTotal : 1;
}
