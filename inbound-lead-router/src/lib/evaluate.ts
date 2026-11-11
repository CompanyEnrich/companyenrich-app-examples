import type { CompanyFacts } from './company';
import type { RoutingConfig, ScoringConfig } from './config';
import { routeLead, type RouteDecision } from './route';
import { scoreCompany, type ScoreResult } from './score';
import { tierFor, type TierDecision } from './tier';

export interface Evaluation {
  score: ScoreResult | null;
  tier: TierDecision | null;
  route: RouteDecision;
}

/**
 * Score, tier and route one company. Pure and synchronous, so the webhook, the
 * CSV scorer and the playground (in the browser, with edited weights) share it.
 * A null company (free-mail, not found) is not scored and routes on tier "not scored".
 */
export function evaluateCompany(company: CompanyFacts | null, scoring: ScoringConfig, routing: RoutingConfig, now: Date): Evaluation {
  const score = company ? scoreCompany(company, scoring, now) : null;
  const tier = score ? tierFor(score.total, scoring.tiers) : null;
  const route = routeLead({ tier: tier?.tier ?? null, company }, routing);
  return { score, tier, route };
}
