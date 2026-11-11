import type { CompanySearchQuery } from '@companyenrich/sdk';
import { lookalikeCost } from '@/lib/credits';
import type { SuggestRequest } from '@/lib/requests';
import type { BenchmarkClient } from './client';
import type { ServerState, SuggestedPeer } from './state';

type SuggestQuery = Pick<SuggestRequest, 'company' | 'count' | 'peers'>;

export interface SuggestEstimate {
  /** Lookalikes the free count found, after excluding the company and its current peers. */
  available: number;
  requested: number;
  /** What the paid search will ask for: the request, or fewer if fewer exist. */
  pageSize: number;
  credits: number;
  cached: boolean;
  /** What this server process may still spend (MAX_CREDITS minus what it has spent). */
  budgetRemaining: number;
}

export interface SuggestRun {
  /** In the API's ranking order, with its scores. */
  peers: SuggestedPeer[];
  creditsCharged: number;
  cached: boolean;
}

/** Lookalikes of the company, minus the company itself and peers already picked. */
function lookalikeQuery(request: SuggestQuery): CompanySearchQuery {
  return {
    lookalike: { domains: [request.company] },
    filter: { domain: { notIn: [request.company, ...request.peers] } },
  };
}

function cacheKey(request: SuggestQuery): string {
  return [request.company, request.count, ...[...request.peers].sort()].join('|');
}

/** Free: `companies.count` with the same query the paid search will use. */
export async function estimateSuggestions(
  client: BenchmarkClient,
  state: ServerState,
  request: SuggestQuery,
): Promise<SuggestEstimate> {
  const budgetRemaining = state.budget.remaining;
  const cachedPeers = state.suggestions.get(cacheKey(request));
  if (cachedPeers) {
    const size = cachedPeers.length;
    return { available: size, requested: request.count, pageSize: size, credits: 0, cached: true, budgetRemaining };
  }

  const { count } = await state.limit(() => client.companies.count(lookalikeQuery(request)));
  const pageSize = Math.min(request.count, count);
  return {
    available: count,
    requested: request.count,
    pageSize,
    credits: pageSize === 0 ? 0 : lookalikeCost(pageSize),
    cached: false,
    budgetRemaining,
  };
}

/**
 * Paid: 5 credits per returned company. Call only after a non-zero estimate was
 * confirmed, with that estimate's `pageSize`, so the bill cannot exceed it.
 */
export async function fetchSuggestions(
  client: BenchmarkClient,
  state: ServerState,
  request: SuggestQuery,
  pageSize: number,
): Promise<SuggestRun> {
  const { value, source } = await state.suggestions.getOrLoad(cacheKey(request), async () => {
    const page = await state.limit(() => client.companies.search({ ...lookalikeQuery(request), pageSize }));
    // Keep the API's order: it already applies ranking penalties, so re-sorting by score would be wrong.
    return page.items.map((company) => ({
      domain: company.domain,
      name: company.name || company.domain,
      logoUrl: company.logoUrl || null,
      score: page.scores?.[company.id] ?? null,
    }));
  });
  const loaded = source === 'loaded';
  return { peers: value, creditsCharged: loaded ? lookalikeCost(value.length) : 0, cached: !loaded };
}
