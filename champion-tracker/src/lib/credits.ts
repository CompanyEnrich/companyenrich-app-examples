import type { CompanyEnrich } from '@companyenrich/sdk';

/** Credit prices of the calls this app makes. Counts (people.count) and me() are free. */
export const COST = {
  /** people.enrich: reverse email lookup, charged only when a person is found. */
  emailLookup: 5,
  /** people.get: one profile by id. */
  personGet: 2,
  /** companies.enrich (or companies.get when there is no domain): the company a champion moved to. */
  companyEnrich: 1,
  /** people.search: per person returned. */
  contact: 2,
} as const;

/** The most buyer-persona contacts fetched per new company with --with-contacts. */
export const MAX_CONTACTS = 3;

/** Keeps a running total of what this run spent and refuses anything that would pass the cap. */
export class CreditLedger {
  spent = 0;
  private readonly calls = new Map<string, { count: number; credits: number }>();

  constructor(readonly cap: number) {}

  get remaining(): number {
    return this.cap - this.spent;
  }

  canAfford(credits: number): boolean {
    return this.spent + credits <= this.cap;
  }

  record(call: string, credits: number): void {
    this.spent += credits;
    const line = this.calls.get(call) ?? { count: 0, credits: 0 };
    this.calls.set(call, { count: line.count + 1, credits: line.credits + credits });
  }

  /** For example "people.get x3 = 6, companies.enrich x1 = 1". */
  breakdown(): string {
    if (this.calls.size === 0) return 'no paid calls';
    return [...this.calls].map(([call, line]) => `${call} x${line.count} = ${line.credits}`).join(', ');
  }
}

/** The account's remaining credits, from the free me() endpoint. */
export async function creditBalance(client: CompanyEnrich): Promise<number> {
  const { credits } = await client.me();
  return Math.floor(credits.total - credits.used);
}

export interface CheckPlan {
  due: number;
  toCheck: number;
  deferred: number;
  /** Credits kept free after each profile fetch so a detected move can always be researched. */
  reservePerMove: number;
  /** Spend if nobody moved. */
  estimate: number;
  /** Spend if every checked champion moved, never above the cap. */
  worstCase: number;
}

/**
 * Before each profile fetch the run requires room for the fetch plus one move's research. That
 * rolling reserve means a move found under the cap is always enriched, and the cap is never passed.
 */
export function planCheck(due: number, maxCredits: number, withContacts: boolean): CheckPlan {
  const reservePerMove = moveReserve(withContacts);
  const affordable = maxCredits >= COST.personGet + reservePerMove ? Math.floor((maxCredits - reservePerMove) / COST.personGet) : 0;
  const toCheck = Math.min(due, affordable);
  return {
    due,
    toCheck,
    deferred: due - toCheck,
    reservePerMove,
    estimate: toCheck * COST.personGet,
    worstCase: Math.min(maxCredits, toCheck * (COST.personGet + reservePerMove)),
  };
}

export function moveReserve(withContacts: boolean): number {
  return COST.companyEnrich + (withContacts ? COST.contact * MAX_CONTACTS : 0);
}
