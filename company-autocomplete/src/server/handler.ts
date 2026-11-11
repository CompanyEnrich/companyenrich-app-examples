// A framework-agnostic company lookup endpoint: `(request: Request) => Promise<Response>`.
// Mount it in Next.js, Express, a Cloudflare Worker, Bun, Deno or anything else
// that speaks the Fetch API.
//
//   GET ?q=stri            -> { items: CompanySuggestion[] }   free
//   GET ?domain=stripe.com -> { company, credits, cached }     1 credit, then cached
//
// Two separate protections keep a public form from being abused:
// - a throttle counts every request per client, whatever it costs;
// - credit reservations cap fresh enrichments per client and overall, and are
//   handed back when the API says the lookup was not billed.

import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  CompanyEnrich,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
  type Company,
  type CompanyAutocompleteResponse,
} from '@companyenrich/sdk';
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, normalizeDomain, normalizeQuery } from '../shared/normalize';
import type {
  CompanyProfile,
  CompanySuggestion,
  EnrichResponse,
  ErrorCode,
  ErrorResponse,
  SuggestResponse,
} from '../shared/types';
import type { ClientIpResolver } from './client-ip';
import { LruCache } from './lru-cache';
import { FixedWindowRateLimiter, type RateLimit } from './rate-limiter';

export interface CompanyHandlerOptions {
  /** Defaults to the COMPANYENRICH_API_KEY environment variable, read by the SDK. */
  apiKey?: string;
  /** How long suggestions and enrichments stay cached. Default: 24 hours. */
  cacheTtlMs?: number;
  /** Entries kept per cache before the least recently used is evicted. Default: 1,000. */
  cacheMaxEntries?: number;
  /**
   * Reads the client IP from a header your platform sets (see client-ip.ts).
   * Default: none. Without it, and without `context.clientIp`, every client
   * shares one bucket: strict, but impossible to dodge by forging headers.
   */
  clientIp?: ClientIpResolver;
  /** Requests of any kind allowed per client, cache hits included. Default: 120 per minute. */
  throttle?: RateLimit;
  /** Credits one client may spend on fresh enrichments. Default: 10 per 10 minutes. */
  creditsPerClient?: RateLimit;
  /** Credits all clients together may spend: a hard budget per process. Default: 500 per day. */
  creditBudget?: RateLimit;
  /** Receives unexpected upstream errors and budget warnings. Default: one line on console.error. */
  onError?: (error: unknown) => void;
  /** Passed to the SDK. Tests inject a fake here. */
  fetch?: typeof fetch;
  /** Clock used by the cache and the limits. Tests inject a fake here. */
  now?: () => number;
}

export interface RequestContext {
  /**
   * The client IP from the connection itself, for adapters that know it, such
   * as Express (`req.ip`). Takes precedence over the `clientIp` option.
   */
  clientIp?: string | null;
}

export type CompanyHandler = (request: Request, context?: RequestContext) => Promise<Response>;

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 1_000;
const DEFAULT_THROTTLE: RateLimit = { limit: 120, windowMs: 60 * 1000 };
const DEFAULT_CREDITS_PER_CLIENT: RateLimit = { limit: 10, windowMs: 10 * 60 * 1000 };
const DEFAULT_CREDIT_BUDGET: RateLimit = { limit: 500, windowMs: 24 * 60 * 60 * 1000 };
const SHARED_BUCKET = 'unidentified clients';
// A suggestion that arrives after a few seconds is no longer useful to someone typing.
const AUTOCOMPLETE_REQUEST = { timeoutMs: 8_000, maxRetries: 1 };
// Paid calls are sent once, so one pick never costs more than one enrichment.
const ENRICH_REQUEST = { maxRetries: 0 };

/** Thrown when the SDK cannot be created, which only happens without an API key. */
class NotConfiguredError extends Error {
  override name = 'NotConfiguredError';
}

export function createCompanyHandler(options: CompanyHandlerOptions = {}): CompanyHandler {
  const now = options.now ?? Date.now;
  const cacheOptions = {
    ttlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    maxEntries: options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
    now,
  };
  const suggestionCache = new LruCache<CompanySuggestion[]>(cacheOptions);
  // Holds the pending lookup itself, so two people picking the same company at
  // the same moment share one paid call. `null` records "no such company".
  const companyCache = new LruCache<Promise<CompanyProfile | null>>(cacheOptions);
  const throttle = new FixedWindowRateLimiter({ ...(options.throttle ?? DEFAULT_THROTTLE), now });
  const clientCredits = new FixedWindowRateLimiter({ ...(options.creditsPerClient ?? DEFAULT_CREDITS_PER_CLIENT), now });
  const budget = new FixedWindowRateLimiter({ ...(options.creditBudget ?? DEFAULT_CREDIT_BUDGET), now });
  const reportError = options.onError ?? ((error: unknown) => console.error(`[company-api] ${describeError(error)}`));
  // Report an exhausted budget once per window, not on every refused request.
  let budgetReportedUntil = 0;

  let client: CompanyEnrich | undefined;
  // Created on first use, so importing the handler never throws (for example
  // during `next build` on a machine without the key).
  function api(): CompanyEnrich {
    if (!client) {
      try {
        client = new CompanyEnrich({ apiKey: options.apiKey, fetch: options.fetch, timeoutMs: 30_000 });
      } catch (error) {
        throw new NotConfiguredError(error instanceof Error ? error.message : String(error));
      }
    }
    return client;
  }

  async function suggest(rawQuery: string): Promise<Response> {
    const query = normalizeQuery(rawQuery);
    if (query.length > MAX_QUERY_LENGTH) {
      return errorResponse(400, 'invalid_request', `Search text can be at most ${MAX_QUERY_LENGTH} characters.`);
    }
    if (query.length < MIN_QUERY_LENGTH) return jsonResponse<SuggestResponse>({ items: [] });

    const cached = suggestionCache.get(query);
    if (cached) return jsonResponse<SuggestResponse>({ items: cached }, { 'x-cache': 'hit' });

    const page = await api().companies.autocomplete(query, AUTOCOMPLETE_REQUEST);
    const items = page.items.map(toSuggestion);
    suggestionCache.set(query, items);
    return jsonResponse<SuggestResponse>({ items }, { 'x-cache': 'miss' });
  }

  async function enrich(rawDomain: string, clientKey: string): Promise<Response> {
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      return errorResponse(400, 'invalid_request', 'Enter a company website, like stripe.com.');
    }

    let lookup = companyCache.get(domain);
    const cached = lookup !== undefined;
    if (!lookup) {
      const reservation = reserveCredit(clientKey);
      if (reservation instanceof Response) return reservation;
      lookup = lookUpCompany(domain);
      companyCache.set(domain, lookup);
      lookup.then(
        (company) => {
          if (!company) reservation.release(); // a 404 is free
        },
        (error: unknown) => {
          companyCache.delete(domain); // failures are not cached, so the next request tries again
          if (wasNotBilled(error)) reservation.release();
        },
      );
    }

    const company = await lookup;
    if (!company) return errorResponse(404, 'not_found', `No company data found for ${domain}.`);
    return jsonResponse<EnrichResponse>({ company, credits: cached ? 0 : 1, cached }, { 'x-cache': cached ? 'hit' : 'miss' });
  }

  /** Holds one credit against the client's allowance and the overall budget, or refuses. */
  function reserveCredit(clientKey: string): { release: () => void } | Response {
    const perClient = clientCredits.consume(clientKey);
    if (!perClient.allowed) {
      return errorResponse(429, 'rate_limited', 'Too many company lookups. Try again in a few minutes.', {
        'retry-after': String(perClient.retryAfterSeconds),
      });
    }
    const overall = budget.consume('all clients');
    if (!overall.allowed) {
      perClient.release();
      if (now() >= budgetReportedUntil) {
        budgetReportedUntil = now() + overall.retryAfterSeconds * 1000;
        reportError(new Error('Credit budget reached; enrichment is paused until the window resets.'));
      }
      return errorResponse(503, 'budget_exhausted', 'Company details are unavailable right now. Fill in the fields yourself.', {
        'retry-after': String(overall.retryAfterSeconds),
      });
    }
    return {
      release: () => {
        perClient.release();
        overall.release();
      },
    };
  }

  async function lookUpCompany(domain: string): Promise<CompanyProfile | null> {
    try {
      return toProfile(await api().companies.enrich({ domain }, ENRICH_REQUEST));
    } catch (error) {
      if (error instanceof NotFoundError) return null; // free, and worth caching
      throw error;
    }
  }

  function upstreamErrorResponse(error: unknown): Response {
    if (error instanceof RateLimitError) {
      const retryAfter = error.headers.get('retry-after');
      return errorResponse(429, 'rate_limited', 'Company lookup is busy. Try again in a moment.', retryAfter ? { 'retry-after': retryAfter } : {});
    }
    reportError(error);
    if (error instanceof NotConfiguredError || error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      return errorResponse(503, 'not_configured', 'Company lookup is not available right now.');
    }
    if (error instanceof PaymentRequiredError) {
      return errorResponse(503, 'unavailable', 'Company lookup is not available right now.');
    }
    if (error instanceof BadRequestError || error instanceof ValidationError) {
      return errorResponse(400, 'invalid_request', 'That search could not be processed.');
    }
    return errorResponse(502, 'upstream_error', 'Company lookup failed. Please try again.');
  }

  return async function handleCompanyRequest(request: Request, context: RequestContext = {}): Promise<Response> {
    if (request.method !== 'GET') {
      return errorResponse(405, 'invalid_request', 'Only GET is supported.', { allow: 'GET' });
    }
    const clientKey = context.clientIp || options.clientIp?.(request) || SHARED_BUCKET;
    const throttled = throttle.consume(clientKey);
    if (!throttled.allowed) {
      return errorResponse(429, 'rate_limited', 'Too many requests. Try again in a minute.', {
        'retry-after': String(throttled.retryAfterSeconds),
      });
    }

    const params = new URL(request.url).searchParams;
    const query = params.get('q');
    const domain = params.get('domain');
    try {
      if (query !== null && domain === null) return await suggest(query);
      if (domain !== null && query === null) return await enrich(domain, clientKey);
      return errorResponse(400, 'invalid_request', 'Pass either ?q=<text> or ?domain=<website>.');
    } catch (error) {
      return upstreamErrorResponse(error);
    }
  };
}

/**
 * Errors where the API definitely did not charge: it refused the request
 * (bad key, no credits, invalid input, rate limit) or it never got that far.
 * Server errors and timeouts are ambiguous, so their reservation is kept.
 */
function wasNotBilled(error: unknown): boolean {
  return (
    error instanceof NotConfiguredError ||
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    error instanceof PaymentRequiredError ||
    error instanceof BadRequestError ||
    error instanceof ValidationError ||
    error instanceof RateLimitError
  );
}

function toSuggestion(item: CompanyAutocompleteResponse['items'][number]): CompanySuggestion {
  return { domain: item.domain, name: item.name || item.domain, logoUrl: item.logoUrl || null };
}

// The whitelist: copy the handful of fields a form needs, nothing else.
function toProfile(company: Company): CompanyProfile {
  const location = company.location;
  return {
    id: company.id,
    domain: company.domain,
    name: company.name || company.domain,
    logoUrl: company.logoUrl || null,
    industry: company.industry ?? null,
    employees: company.employees ?? null,
    revenue: company.revenue ?? null,
    foundedYear: company.foundedYear ?? null,
    country: location?.country ? { code: location.country.code, name: location.country.name } : null,
    state: location?.state?.name ?? null,
    city: location?.city?.name ?? null,
    linkedinUrl: company.socials?.linkedinUrl ?? null,
  };
}

function jsonResponse<T>(body: T, headers: Record<string, string> = {}): Response {
  return Response.json(body, { headers: { 'cache-control': 'private, max-age=300', ...headers } });
}

function errorResponse(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  const body: ErrorResponse = { error: { code, message } };
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const trace = error.traceId ? ` (trace ${error.traceId})` : '';
    return `${error.name} ${error.status}: ${error.detail ?? error.title ?? error.message}${trace}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
