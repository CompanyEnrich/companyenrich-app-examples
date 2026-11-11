import type { CompanyExpansion } from '@companyenrich/sdk';
import type { Assignment } from './assign';
import type { CompanyFacts } from './company';
import type { Tier } from './enums';
import type { PersonSummary } from './people';
import type { RouteDecision } from './route';
import type { ScoreResult } from './score';
import type { TierDecision } from './tier';

// The response of POST /api/inbound: the decision up top, then every step that led to it.

export type LeadStatus = 'scored' | 'free-mail' | 'not-found' | 'invalid-domain' | 'over-budget';

export type EnrichStep =
  | { status: 'skipped'; reason: string }
  | {
      status: 'found' | 'not-found' | 'invalid-domain';
      /** `shared`: a simultaneous request for the same domain made the call. */
      source: 'api' | 'cache' | 'shared';
      expand: CompanyExpansion[];
      credits: number;
      cachedAt: string | null;
    };

export type PeopleStep =
  | { status: 'skipped'; reason: string }
  | { status: 'none-found' | 'found'; matching: number; people: PersonSummary[]; source: 'api' | 'cache' | 'shared'; credits: number }
  | { status: 'error'; reason: string; uncertainCredits: number };

export type AlertStep =
  | { channel: 'none'; reason: string }
  | { channel: 'log'; reason: string }
  | { channel: 'slack'; delivered: boolean; status: number | null; error: string | null };

export interface DecisionTrace {
  id: string;
  receivedAt: string;
  lead: { email: string; name: string | null; source: string | null; domain: string };
  status: LeadStatus;
  decision: {
    tier: Tier | null;
    score: number | null;
    maxScore: number | null;
    team: string;
    teamLabel: string;
    owner: string;
    summary: string;
  };
  company: CompanyFacts | null;
  people: PersonSummary[];
  credits: {
    /** Confirmed spend for this lead. */
    spent: number;
    /** Held for a call that failed with a 5xx or timeout and may have been billed. */
    uncertain: number;
    enrich: number;
    people: number;
    remainingToday: number;
  };
  trace: {
    freeMail: { isFreeMail: boolean; matched: string | null };
    enrichment: EnrichStep;
    score: ScoreResult | null;
    tier: TierDecision | null;
    routing: RouteDecision;
    assignment: Assignment;
    people: PeopleStep;
    alert: AlertStep;
  };
  timings: { totalMs: number; enrichMs: number; peopleMs: number; alertMs: number };
}
