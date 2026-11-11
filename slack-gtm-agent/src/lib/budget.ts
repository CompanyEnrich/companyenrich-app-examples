import fs from 'node:fs';
import path from 'node:path';

export interface Limits {
  /** A paid step estimated above this many credits waits for an Approve click. */
  approvalThreshold: number;
  /** Most credits one command or one agent question may spend. */
  questionCap: number;
  /** Most credits one Slack user may spend per UTC day. */
  dailyUserCap: number;
  /** Most credits everyone together may spend through this bot per UTC day. */
  dailyTotalCap: number;
}

export type SpendCheck = { ok: true } | { ok: false; reason: string };

export function needsApproval(estimate: number, limits: Limits): boolean {
  return estimate > limits.approvalThreshold;
}

/** Would spending `estimate` more credits break the per-question, per-user or total daily cap? */
export function checkSpend(input: {
  estimate: number;
  questionSpent: number;
  userSpentToday: number;
  totalSpentToday: number;
  limits: Limits;
}): SpendCheck {
  const { estimate, questionSpent, userSpentToday, totalSpentToday, limits } = input;
  if (estimate <= 0) return { ok: true };
  if (questionSpent + estimate > limits.questionCap) {
    return {
      ok: false,
      reason: `estimated ${estimate} credits would exceed the per-question cap of ${limits.questionCap} (${questionSpent} already spent on this question)`,
    };
  }
  if (userSpentToday + estimate > limits.dailyUserCap) {
    return {
      ok: false,
      reason: `estimated ${estimate} credits would exceed your daily cap of ${limits.dailyUserCap} (${userSpentToday} spent today)`,
    };
  }
  if (totalSpentToday + estimate > limits.dailyTotalCap) {
    return {
      ok: false,
      reason: `estimated ${estimate} credits would exceed this bot's daily cap of ${limits.dailyTotalCap} for everyone together (${totalSpentToday} spent today)`,
    };
  }
  return { ok: true };
}

type DayTotals = Record<string, number>;

/** Credits held for one call, on the UTC day the call started. */
export interface Reservation {
  readonly userId: string;
  readonly day: string;
  readonly credits: number;
}

/**
 * Credits spent per Slack user per UTC day, and their total. Kept in memory and, when a
 * file path is given, written to a small JSON file after every change, so a restart (or
 * a crash midway through a question) does not reset the daily caps.
 *
 * A paid call reserves its estimate before it starts and settles to the real charge
 * when it ends, so calls still in flight count against the caps.
 */
export class Ledger {
  private day: string;
  private totals: DayTotals = {};

  constructor(
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = this.today();
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: string; totals?: DayTotals };
      if (saved.day === this.day && saved.totals) this.totals = saved.totals;
    }
  }

  spentToday(userId: string): number {
    this.rollOver();
    return this.totals[userId] ?? 0;
  }

  /** Credits spent today by everyone together. */
  totalToday(): number {
    this.rollOver();
    return Object.values(this.totals).reduce((sum, credits) => sum + credits, 0);
  }

  reserve(userId: string, credits: number): Reservation {
    this.rollOver();
    this.change(userId, credits);
    return { userId, day: this.day, credits };
  }

  /**
   * Replace a reservation with the real charge. A refund only applies on the day the
   * reservation was made: after midnight, yesterday's totals are gone, and refunding
   * yesterday's reservation would erase spend made today. Extra charges always count.
   */
  settle(reservation: Reservation, charged: number): void {
    this.rollOver();
    const difference = charged - reservation.credits;
    if (difference < 0 && reservation.day !== this.day) return;
    this.change(reservation.userId, difference);
  }

  private change(userId: string, credits: number): void {
    if (credits === 0) return;
    this.totals[userId] = Math.max(0, (this.totals[userId] ?? 0) + credits);
    this.save();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private rollOver(): void {
    const today = this.today();
    if (today !== this.day) {
      this.day = today;
      this.totals = {};
    }
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ day: this.day, totals: this.totals }, null, 2));
  }
}
