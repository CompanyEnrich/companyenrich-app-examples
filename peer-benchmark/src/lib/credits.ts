/** CompanyEnrich prices for the calls this app makes (https://docs.companyenrich.com). */
export const PRICES = {
  /** `companies.workforce`: per successful 12-month page. A 404 is free. */
  workforcePage: 1,
  /** `companies.search` with `lookalike`: per returned company. */
  lookalikeResult: 5,
} as const;

/** An empty paid search still bills one result, so the floor is one result's price. */
export function lookalikeCost(pageSize: number): number {
  return Math.max(1, pageSize) * PRICES.lookalikeResult;
}

/** Upper bound: companies without workforce data cost nothing, but we cannot know which in advance. */
export function workforceCost(uncachedCompanies: number): number {
  return uncachedCompanies * PRICES.workforcePage;
}

/**
 * A spending limit that paid calls draw from before they run. The same class
 * caps one request (the credits you confirmed) and the whole server process
 * (MAX_CREDITS). `take` is synchronous, so concurrent requests cannot both
 * claim the last credit.
 */
export class CreditAllowance {
  private used = 0;

  constructor(readonly limit: number) {}

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return this.limit - this.used;
  }

  /** Claims credits before a paid call. Returns false, claiming nothing, when that would pass the limit. */
  take(credits: number): boolean {
    if (this.used + credits > this.limit) return false;
    this.used += credits;
    return true;
  }

  /** Gives back credits a call turned out not to cost, such as a 404. */
  refund(credits: number): void {
    this.used = Math.max(0, this.used - credits);
  }
}
