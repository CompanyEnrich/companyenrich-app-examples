import type { CompanyExpansion } from '@companyenrich/sdk';

// CompanyEnrich v2 prices used for estimates. See https://docs.companyenrich.com
/** `companies.enrich` and each found company in `enrichBatch`: 1 credit, plus 1 per paid expansion. */
export function enrichCost(expand: readonly CompanyExpansion[]): number {
  return 1 + expand.length;
}

/** `people.search`: 2 credits per returned person. An empty page still costs one result. */
export const PEOPLE_CREDITS_PER_RESULT = 2;

export function peopleSearchCost(returned: number): number {
  return PEOPLE_CREDITS_PER_RESULT * Math.max(1, returned);
}

/** Credits held for one paid call, tagged with the UTC day they count against. */
export interface Hold {
  day: string;
  credits: number;
}

export type Reservation = { ok: true; hold: Hold } | { ok: false; reason: string };

/** Something paid calls reserve against before they are sent, then settle to the real cost. */
export interface Budget {
  reserve(credits: number): Reservation;
  /** Replaces a hold with what the call actually cost (0 releases it). */
  settle(hold: Hold, actual: number): void;
}

/**
 * A daily spending cap for unattended paths (the webhook and playground), shared
 * by all clients. Reserving the worst case first means concurrent requests cannot
 * overshoot it. In memory, so it resets when the server restarts; days are UTC.
 */
export class DailyCreditLedger implements Budget {
  private day = '';
  private spent = 0;

  constructor(
    readonly cap: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Credits still available today, after holds. */
  remaining(): number {
    this.rollOver();
    return Math.max(0, this.cap - this.spent);
  }

  reserve(credits: number): Reservation {
    const left = this.remaining();
    if (credits > left) return { ok: false, reason: `Daily credit cap reached: ${credits} needed, ${left} of ${this.cap} left today` };
    this.spent += credits;
    return { ok: true, hold: { day: this.day, credits } };
  }

  settle(hold: Hold, actual: number): void {
    this.rollOver();
    // A hold from before midnight belongs to a day that is already closed; it must not free today's credits.
    if (hold.day !== this.day) return;
    this.spent = Math.max(0, this.spent - hold.credits + actual);
  }

  private rollOver(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }
}

/** One lead's spending: its own cap (MAX_CREDITS_PER_LEAD) on top of the shared daily cap. */
export class LeadBudget implements Budget {
  /** Credits this lead has spent or holds. */
  private committed = 0;

  constructor(
    private readonly daily: Budget,
    readonly max: number,
  ) {}

  reserve(credits: number): Reservation {
    if (this.committed + credits > this.max) {
      return { ok: false, reason: `Per-lead cap reached: ${credits} more credits would pass MAX_CREDITS_PER_LEAD (${this.max})` };
    }
    const reservation = this.daily.reserve(credits);
    if (reservation.ok) this.committed += credits;
    return reservation;
  }

  settle(hold: Hold, actual: number): void {
    this.committed += actual - hold.credits;
    this.daily.settle(hold, actual);
  }
}
