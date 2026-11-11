/** v2 credit prices. See https://docs.companyenrich.com for the current list. */
export const CREDITS = {
  companyFilterResult: 1,
  companySemanticResult: 2,
  personResult: 2,
  companyEnrichment: 1,
  /** Per paid expansion (financial, technologies, workforce, ...) per returned company. */
  expansion: 1,
} as const;

export interface CreditRequest {
  units: number;
  unitCost: number;
  /** Rounds a grant down to what the requester can use, so the rest stays available. */
  fit?(granted: number): number;
}

/**
 * Hands out the per-run credit cap to watchers in config order.
 * Each grant reserves the worst case, so the run can never spend more than the cap.
 */
export class CreditBudget {
  private reserved = 0;

  constructor(readonly cap: number) {}

  get remaining(): number {
    return this.cap - this.reserved;
  }

  get total(): number {
    return this.reserved;
  }

  /** Grants as many of the requested units as still fit under the cap. */
  grant({ units, unitCost, fit }: CreditRequest): number {
    const affordable = unitCost === 0 ? units : Math.floor(this.remaining / unitCost);
    const possible = Math.max(0, Math.min(units, affordable));
    const granted = fit ? Math.min(possible, fit(possible)) : possible;
    this.reserved += granted * unitCost;
    return granted;
  }
}

/** What a search page costs: an empty page still bills one result's base price. */
export function searchCharge(results: number, basePrice: number, expansionsPerResult = 0): number {
  return Math.max(results, 1) * basePrice + results * expansionsPerResult * CREDITS.expansion;
}
