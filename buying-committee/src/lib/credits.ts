import { relabelCandidates } from './workforce';
import type { CoveragePlan } from './types';

/** v2 prices used by this app. https://docs.companyenrich.com */
export const PRICES = {
  /** `people.search`, per returned person. An empty page still costs one result. */
  personResult: 2,
  /** `companies.workforce`, per 12-month page. */
  workforcePage: 1,
  /** `people.findEmail`, only when an email you have not accessed before is found. */
  emailFound: 10,
} as const;

export interface SearchLine {
  domain: string;
  roleKey: string;
  label: string;
  people: number;
  credits: number;
}

export interface CreditEstimate {
  searches: SearchLine[];
  searchCredits: number;
  workforceCredits: number;
  /** Extra searches the workforce check may add when it relabels an empty role. */
  relabelReserve: number;
  /** The most the paid step can spend. Use it as the confirmed cap. */
  maxCredits: number;
}

/**
 * Upper bound for the paid step. Each role with matches costs
 * min(limit, count) x 2 credits; roles with a count of 0 are skipped, so cost nothing.
 */
export function estimateCredits(plan: CoveragePlan, options: { workforce: boolean }): CreditEstimate {
  const searches: SearchLine[] = plan.accounts.flatMap(({ account, roles }) =>
    roles
      .filter(({ count }) => count > 0)
      .map(({ role, count }) => {
        const people = Math.min(role.limit, count);
        return { domain: account.domain, roleKey: role.key, label: role.label, people, credits: people * PRICES.personResult };
      }),
  );
  const searchCredits = sum(searches.map((line) => line.credits));
  const workforceCredits = options.workforce ? plan.accounts.length * PRICES.workforcePage : 0;
  const relabelReserve = options.workforce
    ? sum(plan.accounts.map(({ roles }) => relabelCandidates(roles).length)) * PRICES.personResult
    : 0;
  return { searches, searchCredits, workforceCredits, relabelReserve, maxCredits: searchCredits + workforceCredits + relabelReserve };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * A credit ledger with a hard cap. A paid call reserves its worst case first and
 * settles with what it actually cost, so concurrent calls can never overshoot.
 * A child budget (one web request) also counts against its parent (the server's cap).
 */
export class CreditBudget {
  private committed = 0;
  spent = 0;

  constructor(
    readonly cap: number,
    private readonly parent?: CreditBudget,
  ) {}

  child(cap: number): CreditBudget {
    return new CreditBudget(cap, this);
  }

  /** Credits that can still be reserved here and in every parent. */
  get available(): number {
    const own = this.cap - this.committed;
    return this.parent ? Math.min(own, this.parent.available) : own;
  }

  reserve(credits: number): boolean {
    if (this.committed + credits > this.cap) return false;
    if (this.parent && !this.parent.reserve(credits)) return false;
    this.committed += credits;
    return true;
  }

  settle(reserved: number, actual: number): void {
    this.committed += actual - reserved;
    this.spent += actual;
    this.parent?.settle(reserved, actual);
  }
}
