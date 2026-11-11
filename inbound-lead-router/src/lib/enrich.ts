import { BadRequestError, NotFoundError, RateLimitError, ValidationError, type CompanyEnrich, type CompanyExpansion } from '@companyenrich/sdk';
import type { CacheEntry, TtlCache } from './cache';
import type { ApiCall } from './client';
import { toCompanyFacts, type CompanyFacts } from './company';
import { SingleFlight } from './concurrency';
import { enrichCost, type Budget } from './credits';
import { certainlyNotBilled } from './errors';

/** What we learned about a domain. Stored in the 24-hour cache. */
export type CompanyLookup =
  | { status: 'found'; company: CompanyFacts; expand: CompanyExpansion[] }
  | { status: 'not-found' }
  | { status: 'invalid-domain' };

export type CompanyCache = TtlCache<CompanyLookup>;

export const COMPANY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type EnrichResult =
  | {
      status: 'done';
      lookup: CompanyLookup;
      /** `shared`: another request for the same domain was already running and paid for it. */
      source: 'api' | 'cache' | 'shared';
      credits: number;
      /** When the cached answer was fetched. */
      cachedAt: string | null;
    }
  | { status: 'over-budget'; reason: string; cost: number }
  /** The call failed after it was sent (5xx, timeout), so it may have been billed. */
  | { status: 'failed'; error: unknown; uncertainCredits: number };

/**
 * A cached answer is good enough when it is a miss, or when it already has every
 * expansion the current scoring config needs. Otherwise we would score funding or
 * technologies as unknown just because an older config did not ask for them.
 */
export function usableCacheEntry(cache: CompanyCache, domain: string, expand: readonly CompanyExpansion[]): CacheEntry<CompanyLookup> | undefined {
  const entry = cache.get(domain);
  if (!entry) return undefined;
  if (entry.value.status !== 'found') return entry;
  const have = entry.value.expand;
  return expand.every((name) => have.includes(name)) ? entry : undefined;
}

/** Single-domain enrichment for the webhook: cache first, then one shared in-flight call per domain. */
export class CompanyLookups {
  private readonly flights = new SingleFlight<CompanyLookup>();

  constructor(
    private readonly call: ApiCall,
    readonly cache: CompanyCache,
  ) {}

  async enrich(domain: string, expand: CompanyExpansion[], budget: Budget): Promise<EnrichResult> {
    const cached = usableCacheEntry(this.cache, domain, expand);
    if (cached) return { status: 'done', lookup: cached.value, source: 'cache', credits: 0, cachedAt: new Date(cached.storedAt).toISOString() };

    const key = `${domain}|${expand.join(',')}`;
    const running = this.flights.pending(key);
    if (running) {
      try {
        return { status: 'done', lookup: await running, source: 'shared', credits: 0, cachedAt: null };
      } catch (error) {
        return { status: 'failed', error, uncertainCredits: 0 }; // the request that sent it carries any uncertain cost
      }
    }

    // Nothing above awaited, so no other request can start the same lookup in between.
    const cost = enrichCost(expand);
    const reservation = budget.reserve(cost);
    if (!reservation.ok) return { status: 'over-budget', reason: reservation.reason, cost };

    try {
      const lookup = await this.flights.start(key, () => this.fetch(domain, expand));
      const credits = lookup.status === 'found' ? cost : 0; // a miss (404) costs nothing
      budget.settle(reservation.hold, credits);
      return { status: 'done', lookup, source: 'api', credits, cachedAt: null };
    } catch (error) {
      const uncertainCredits = certainlyNotBilled(error) ? 0 : cost;
      budget.settle(reservation.hold, uncertainCredits);
      return { status: 'failed', error, uncertainCredits };
    }
  }

  private async fetch(domain: string, expand: CompanyExpansion[]): Promise<CompanyLookup> {
    let lookup: CompanyLookup;
    try {
      const company = await this.call((client) => enrichOnce(client, domain, expand));
      lookup = { status: 'found', company: toCompanyFacts(company, expand), expand };
    } catch (error) {
      if (error instanceof NotFoundError) lookup = { status: 'not-found' };
      else if (error instanceof ValidationError || error instanceof BadRequestError) lookup = { status: 'invalid-domain' };
      else throw error;
    }
    this.cache.set(domain, lookup);
    // The API may resolve to a canonical domain (mail.example.com -> example.com); remember both.
    if (lookup.status === 'found' && lookup.company.domain !== domain) this.cache.set(lookup.company.domain, lookup);
    return lookup;
  }
}

const RATE_LIMIT_RETRIES = 2;

/**
 * `companies.enrich` is a paid GET, so it is sent once (`maxRetries: 0`) and one
 * reservation always matches one request. A 429 is never billed, so retry those ourselves.
 */
async function enrichOnce(client: CompanyEnrich, domain: string, expand: CompanyExpansion[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.companies.enrich({ domain, expand }, { maxRetries: 0 });
    } catch (error) {
      if (!(error instanceof RateLimitError) || attempt >= RATE_LIMIT_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
