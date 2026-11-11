import type { Log } from './types.js';

// Credit prices from the v2 API reference (https://docs.companyenrich.com).
export const COST = {
  person: 2, // per person returned by people.search
  workforcePage: 1, // per companies.workforce page (latest 12 months)
} as const;

/** A paid search that returns nothing is still billed at one result's base price. */
export function searchCharge(returned: number, pricePerResult: number): number {
  return Math.max(1, returned) * pricePerResult;
}

export interface CostLine {
  step: string;
  detail: string;
  credits: number;
}

export interface LedgerEntry extends CostLine {
  estimated: number;
}

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The shortlist page size: what was asked for, but never more people than the free count found. */
export function shortlistSize(people: number, matching: number): number {
  return Math.max(0, Math.min(people, matching));
}

/**
 * Upper bound for the paid steps. The search is sent with `pageSize = profiles`, so it can't
 * return (or bill) more, and the trend step can't look up more companies than there are profiles.
 */
export function estimatePaidSteps(profiles: number, trendTop: number): CostLine[] {
  const companies = Math.min(trendTop, profiles);
  const lines: CostLine[] = [
    { step: 'shortlist', detail: `${plural(profiles, 'profile')} x ${COST.person}`, credits: searchCharge(profiles, COST.person) },
  ];
  if (companies > 0) {
    lines.push({ step: 'team trends', detail: `${plural(companies, 'company', 'companies')} x ${COST.workforcePage}`, credits: companies * COST.workforcePage });
  }
  return lines;
}

/** Tracks what each paid step was expected to cost and what it was billed. */
export class CreditLedger {
  readonly entries: LedgerEntry[] = [];

  constructor(readonly maxCredits: number) {}

  get spent(): number {
    return this.entries.reduce((sum, entry) => sum + entry.credits, 0);
  }

  record(line: CostLine, credits: number): void {
    this.entries.push({ ...line, estimated: line.credits, credits });
  }

  /** Throws before any spending when what is spent plus `remaining` would pass the cap. */
  check(remaining: readonly CostLine[]): void {
    const total = this.spent + sumCredits(remaining);
    if (total > this.maxCredits) {
      throw new BudgetExceededError(
        `Stopped before spending: the next step would take this run to ${total} credits, above --max-credits ${this.maxCredits}. ` +
          'Lower --people or --trend-top, or raise --max-credits.',
      );
    }
  }
}

export function sumCredits(lines: readonly CostLine[]): number {
  return lines.reduce((sum, line) => sum + line.credits, 0);
}

export function printEstimate(lines: readonly CostLine[], cap: number, log: Log): void {
  const width = Math.max(...lines.map((line) => `${line.step}: ${line.detail}`.length), 'total'.length) + 4;
  const row = (label: string, credits: number) => `  ${`${label} `.padEnd(width, '.')} ${String(credits).padStart(4)}`;
  const total = sumCredits(lines);
  log('Credit estimate (upper bound):');
  for (const line of lines) log(row(`${line.step}: ${line.detail}`, line.credits));
  log(`${row('total', total)}  (cap ${cap}${total > cap ? ', over the cap' : ''})`);
}
