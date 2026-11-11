import type { ScoringConfig } from './config';
import type { Tier } from './enums';

export interface TierDecision {
  tier: Tier;
  reason: string;
}

/** The highest tier whose minimum score the lead reaches. */
export function tierFor(score: number, tiers: ScoringConfig['tiers']): TierDecision {
  for (const tier of ['A', 'B', 'C'] as const) {
    if (score >= tiers[tier]) return { tier, reason: `${score} >= ${tiers[tier]}, the tier ${tier} minimum` };
  }
  return { tier: 'unqualified', reason: `${score} < ${tiers.C}, the tier C minimum` };
}
