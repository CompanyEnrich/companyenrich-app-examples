/**
 * Spend guards for the one paid route. Node runs JavaScript on one thread and
 * `reserve` never awaits, so checking and booking a reservation is atomic: two
 * concurrent requests can never both squeeze into the last credits.
 */

export interface Reservation {
  readonly credits: number;
  readonly day: string;
}

/** A process-wide cap on paid-search credits per UTC day. */
export class CreditBudget {
  private day = '';
  private spent = 0;

  constructor(
    readonly maxPerDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  private rollOver(): string {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
    return today;
  }

  /** Credits still available today. */
  remaining(): number {
    this.rollOver();
    return Math.max(0, this.maxPerDay - this.spent);
  }

  /** Books `credits` up front, or returns null when that would exceed today's cap. */
  reserve(credits: number): Reservation | null {
    const day = this.rollOver();
    if (credits <= 0 || this.spent + credits > this.maxPerDay) return null;
    this.spent += credits;
    return { credits, day };
  }

  /**
   * Settles a reservation at what was actually charged (0 when the API
   * definitely did not bill). Only ever gives credits back, never takes more.
   */
  settle(reservation: Reservation, charged: number): void {
    if (reservation.day !== this.rollOver()) return;
    const refund = reservation.credits - Math.min(Math.max(0, charged), reservation.credits);
    this.spent = Math.max(0, this.spent - refund);
  }
}

/** Allows at most `limit` events per key in any rolling `windowMs`. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records an event for `key` if allowed; otherwise returns ms until the next slot opens. */
  take(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: this.windowMs - (now - (recent[0] ?? now)) };
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    // Bound memory: forget the least recently active addresses.
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    return { allowed: true };
  }
}
