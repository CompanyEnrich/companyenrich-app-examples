import { CreditAllowance } from '@/lib/credits';
import type { Workforce } from '@/lib/departments';
import { createLimiter, type Limiter } from '@/lib/limiter';
import { TtlCache } from '@/lib/ttl-cache';
import { ConfigError } from './client';

const ONE_HOUR = 60 * 60 * 1000;
/** Parallel CompanyEnrich calls for the whole process. */
const CONCURRENCY = 4;
const DEFAULT_MAX_CREDITS = 200;

/** A 404 is cached too: asking again within the hour would get the same answer. */
export type WorkforceLookup = { status: 'found'; workforce: Workforce } | { status: 'not-found' };

export interface CompanyName {
  name: string;
  logoUrl: string | null;
}

export interface SuggestedPeer {
  domain: string;
  name: string;
  logoUrl: string | null;
  /** Lookalike ranking score from the API. Not a probability. */
  score: number | null;
}

/** Everything the route handlers share within one server process. */
export interface ServerState {
  workforce: TtlCache<WorkforceLookup>;
  names: TtlCache<CompanyName>;
  suggestions: TtlCache<SuggestedPeer[]>;
  /** Every CompanyEnrich call goes through this one limiter. */
  limit: Limiter;
  /** Credits this process may spend in total, across all requests. */
  budget: CreditAllowance;
  /** The clock the caches use, injectable for tests. */
  now: () => number;
}

export function createState(options: { maxCredits?: number; now?: () => number } = {}): ServerState {
  const { maxCredits = DEFAULT_MAX_CREDITS, now = Date.now } = options;
  return {
    workforce: new TtlCache(ONE_HOUR, now),
    names: new TtlCache(ONE_HOUR, now),
    suggestions: new TtlCache(ONE_HOUR, now),
    limit: createLimiter(CONCURRENCY),
    budget: new CreditAllowance(maxCredits),
    now,
  };
}

/** MAX_CREDITS from the environment: a whole number, or the default when unset. */
export function readMaxCredits(value = process.env.MAX_CREDITS): number {
  if (value === undefined || value.trim() === '') return DEFAULT_MAX_CREDITS;
  const credits = Number(value);
  if (!Number.isInteger(credits) || credits < 0) {
    throw new ConfigError(`MAX_CREDITS must be a whole number of credits, got "${value}".`);
  }
  return credits;
}

// `next dev` re-evaluates modules on every edit; keeping the state on
// globalThis means a code change neither re-bills cached calls nor resets the budget.
const store = globalThis as typeof globalThis & { peerBenchmarkState?: ServerState };

/** One shared state per server process. */
export function sharedState(): ServerState {
  store.peerBenchmarkState ??= createState({ maxCredits: readMaxCredits() });
  return store.peerBenchmarkState;
}
