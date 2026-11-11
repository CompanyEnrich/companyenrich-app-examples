// Browser-side access to the company endpoint, with a small in-memory cache so
// retyping a query or re-picking a company does not hit the server again.

import type { CompanySuggestion, EnrichResponse, ErrorCode, ErrorResponse, SuggestResponse } from '../shared/types';

export interface CompanyClient {
  suggest(query: string, signal?: AbortSignal): Promise<CompanySuggestion[]>;
  enrich(domain: string, signal?: AbortSignal): Promise<EnrichResponse>;
}

/** A failed request. `message` is safe to show to end users. */
export class CompanyLookupError extends Error {
  override name = 'CompanyLookupError';
  readonly code: ErrorCode | 'network_error';

  constructor(code: ErrorCode | 'network_error', message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_CACHED = 100;

export function createCompanyClient(endpoint: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): CompanyClient {
  const suggestions = new Map<string, CompanySuggestion[]>();
  const companies = new Map<string, EnrichResponse>();

  async function getJson<T>(param: 'q' | 'domain', value: string, signal?: AbortSignal): Promise<T> {
    const separator = endpoint.includes('?') ? '&' : '?';
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}${separator}${param}=${encodeURIComponent(value)}`, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new CompanyLookupError('network_error', 'Could not reach the server. Check your connection.');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (body as Partial<ErrorResponse> | null)?.error;
      throw new CompanyLookupError(error?.code ?? 'upstream_error', error?.message ?? `Request failed (${response.status}).`);
    }
    return body as T;
  }

  return {
    async suggest(query, signal) {
      const cached = suggestions.get(query);
      if (cached) return cached;
      const { items } = await getJson<SuggestResponse>('q', query, signal);
      remember(suggestions, query, items);
      return items;
    },

    async enrich(domain, signal) {
      const cached = companies.get(domain);
      // The browser did not even ask the server, so this pick is free.
      if (cached) return { ...cached, credits: 0, cached: true };
      const result = await getJson<EnrichResponse>('domain', domain, signal);
      remember(companies, domain, result);
      return result;
    },
  };
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.set(key, value);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
