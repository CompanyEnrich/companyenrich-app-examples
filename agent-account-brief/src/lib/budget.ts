/** One row of the credit ledger: a single tool call and what it cost. */
export interface LedgerEntry {
  tool: string;
  /** Short human-readable summary of the arguments, e.g. "stripe.com +financial". */
  args: string;
  /** Worst-case credits held before the API call. 0 for free calls and refused calls. */
  reserved: number;
  /** Credits the response implies were billed, from the published prices. null until settled. */
  estimated: number | null;
  /** Why the guard refused the call. Refused calls never reach the API. */
  refused?: string;
}

export type Reservation = { ok: true; entry: LedgerEntry } | { ok: false; error: string };

/**
 * A hard cap on credits for one run.
 *
 * Every paid call reserves its worst-case cost before it is sent. Reservations
 * are never released, so the sum of reservations is an upper bound on what the
 * run can spend, even if a cost estimate turns out to be wrong.
 */
export class CreditBudget {
  readonly ledger: LedgerEntry[] = [];

  constructor(readonly maxCredits: number) {}

  get reserved(): number {
    return this.ledger.reduce((sum, entry) => sum + entry.reserved, 0);
  }

  get estimated(): number {
    return this.ledger.reduce((sum, entry) => sum + (entry.estimated ?? 0), 0);
  }

  get remaining(): number {
    return this.maxCredits - this.reserved;
  }

  /** Holds `credits` for a call, or refuses it (and records the refusal) if the cap would be exceeded. */
  reserve(tool: string, args: string, credits: number): Reservation {
    if (credits > this.remaining) {
      const error = `budget exceeded: this call needs ${credits} credits, ${this.remaining} remaining`;
      this.ledger.push({ tool, args, reserved: 0, estimated: 0, refused: error });
      return { ok: false, error };
    }
    const entry: LedgerEntry = { tool, args, reserved: credits, estimated: null };
    this.ledger.push(entry);
    return { ok: true, entry };
  }

  /** Records what the response implies was billed. The reservation itself stays in place. */
  settle(entry: LedgerEntry, estimated: number): void {
    entry.estimated = estimated;
  }

  /** Records a call that used only free endpoints. */
  recordFree(tool: string, args: string): void {
    this.ledger.push({ tool, args, reserved: 0, estimated: 0 });
  }
}
