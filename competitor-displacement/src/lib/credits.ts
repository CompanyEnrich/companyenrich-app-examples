import type { Log } from './types.js';

// Credit prices from the v2 API reference (https://docs.companyenrich.com).
export const COST = {
  company: 1, // per company returned by a filter search
  expansion: 1, // per paid expansion (financial) per returned company
  person: 2, // per person returned by a people search
} as const;

/**
 * What a paid search bills. An empty page still costs one result's base price;
 * expansions are only charged for results that come back.
 */
export function searchCharge(returned: number, basePrice: number, expansionsPerResult = 0): number {
  return Math.max(1, returned) * basePrice + returned * expansionsPerResult;
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

/** Tracks what each paid call was expected to cost and what it was billed. */
export class CreditLedger {
  readonly entries: LedgerEntry[] = [];

  constructor(readonly maxCredits: number) {}

  get spent(): number {
    return this.entries.reduce((sum, entry) => sum + entry.credits, 0);
  }

  record(step: string, detail: string, estimated: number, credits: number): void {
    this.entries.push({ step, detail, estimated, credits });
  }

  /**
   * Call before a paid step with the estimate for every paid step still to run.
   * Prints the estimate, then throws when spent + remaining would pass the cap.
   */
  check(remaining: readonly CostLine[], log: Log): void {
    const total = this.spent + sumCredits(remaining);
    log(formatEstimate(remaining, this.spent, this.maxCredits));
    if (total > this.maxCredits) {
      throw new BudgetExceededError(
        `Stopped before spending: the next steps would bring this run to ${total} credits, above --max-credits ${this.maxCredits}. ` +
          'Lower --accounts or --contacts, drop --with-funding, or raise --max-credits.',
      );
    }
  }
}

export function sumCredits(lines: readonly CostLine[]): number {
  return lines.reduce((sum, line) => sum + line.credits, 0);
}

export function formatEstimate(remaining: readonly CostLine[], spent: number, cap: number): string {
  const total = spent + sumCredits(remaining);
  const rows: [string, number][] = [
    ...remaining.map((line): [string, number] => [`${line.step}: ${line.detail}`, line.credits]),
    ['already spent by this run', spent],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 4;
  const row = (label: string, credits: number) => `  ${`${label} `.padEnd(width, '.')} ${String(credits).padStart(4)}`;
  return [
    'Credit estimate (upper bound):',
    ...rows.map(([label, credits]) => row(label, credits)),
    `${row('total', total)}  (cap ${cap}${total > cap ? ', over the cap' : ''})`,
  ].join('\n');
}
