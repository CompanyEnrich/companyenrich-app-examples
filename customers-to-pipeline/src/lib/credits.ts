import type { Log } from './types.js';

// Credit prices from the v2 API reference (https://docs.companyenrich.com).
export const COST = {
  enrich: 1, // per company found by enrichBatch
  expansion: 1, // per paid expansion (technologies) per company
  lookalike: 5, // per company returned by a lookalike search
  person: 2, // per person returned by a people search
} as const;

/** A paid page that returns nothing is still billed at one result's base price. */
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

/** Tracks what each paid step was expected to cost and what it was billed. */
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
   * Call before every paid step with the estimate for every step still to run. Prints the estimate,
   * then throws when spent + remaining would pass the cap.
   */
  check(remaining: readonly CostLine[], log: Log): void {
    const total = this.spent + remaining.reduce((sum, line) => sum + line.credits, 0);
    log(formatEstimate(remaining, this.spent, total, this.maxCredits));
    if (total > this.maxCredits) {
      throw new BudgetExceededError(
        `Stopped before spending: this run would use up to ${total} credits, above --max-credits ${this.maxCredits}. ` +
          'Lower --accounts or --contacts, or raise --max-credits.',
      );
    }
  }
}

export function formatEstimate(remaining: readonly CostLine[], spent: number, total: number, cap: number): string {
  const rows: [string, number][] = [
    ...remaining.map((line): [string, number] => [`${line.step}: ${line.detail}`, line.credits]),
    ['already spent this run', spent],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 4;
  const line = (label: string, credits: number) => `  ${`${label} `.padEnd(width, '.')} ${String(credits).padStart(4)}`;
  return [
    'Credit estimate (upper bound):',
    ...rows.map(([label, credits]) => line(label, credits)),
    `${line('total', total)}  (cap ${cap}${total > cap ? ', over the cap' : ''})`,
  ].join('\n');
}
