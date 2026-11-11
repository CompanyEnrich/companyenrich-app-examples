/**
 * The logic behind every route handler, written against an injected SDK client
 * so it can be tested with a fake `fetch`. Route files only parse the request
 * and call these.
 */
import {
  ApiError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  type CompanyEnrich,
} from '@companyenrich/sdk';
import type { z } from 'zod';
import { stableStringify, type LruCache } from './cache';
import { sleep } from './concurrency';
import { searchCredits } from './cost';
import { InputError, errorResult, type HandlerResult } from './errors';
import { computeGrid } from './grid';
import { countryName, type CompanyFilter } from './options';
import type {
  AutocompleteResponse,
  CapabilitiesResponse,
  CountResponse,
  GridResponse,
  IndustriesResponse,
  InterpretResponse,
  PreviewResponse,
  RegionsResponse,
  SampleCompany,
  SearchResponse,
  Suggestion,
} from './responses';
import {
  autocompleteRequestSchema,
  countRequestSchema,
  formatIssues,
  gridRequestSchema,
  interpretRequestSchema,
  previewRequestSchema,
  searchRequestSchema,
} from './schemas';
import type { CreditBudget, SlidingWindowLimiter } from './spend';

export interface Deps {
  /** Built with a `fetch` that goes through the process-wide upstream limiter. */
  client: CompanyEnrich;
  /** Shared cache for free, read-only responses (counts and reference data). */
  cache: LruCache<unknown>;
  paidSearchEnabled: boolean;
  /** Process-wide daily cap on paid-search credits. */
  budget: CreditBudget;
  /** Paid searches per client address per hour. */
  paidSearchThrottle: SlidingWindowLimiter;
  /** Wait before retrying a rate-limited grid cell. Tests set it to 0. */
  rateLimitBackoffMs?: number;
}

/** Facts about the HTTP request that are not part of its body. */
export interface RequestContext {
  clientIp: string;
}

export type Handler = (input: unknown, deps: Deps, context: RequestContext) => Promise<HandlerResult>;

const ok = <T>(body: T): HandlerResult => ({ status: 200, body });

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new InputError(formatIssues(result.error));
  return result.data;
}

/** Runs a handler and maps any error to a clean status and message. */
export async function run(
  handler: Handler,
  input: unknown,
  deps: Deps,
  context: RequestContext = { clientIp: 'unknown' },
): Promise<HandlerResult> {
  try {
    return await handler(input, deps, context);
  } catch (error) {
    return errorResult(error);
  }
}

function cached<T>(deps: Deps, key: string, compute: () => Promise<T>): Promise<T> {
  return deps.cache.getOrCompute(key, compute) as Promise<T>;
}

function countFilter(deps: Deps, filter: CompanyFilter): Promise<CountResponse> {
  return cached(deps, `count:${stableStringify(filter)}`, async () => {
    const { count, total } = await deps.client.companies.count({ filter });
    return { count, total };
  });
}

/** The SDK already retries a 429 twice; a grid cell gets one slower retry on top. */
async function countWithBackoff(deps: Deps, filter: CompanyFilter): Promise<CountResponse> {
  try {
    return await countFilter(deps, filter);
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    await sleep(deps.rateLimitBackoffMs ?? 2_000);
    return countFilter(deps, filter);
  }
}

/** POST /api/interpret: a free semantic count that reports what the API inferred. */
export const interpret: Handler = async (input, deps) => {
  const { query } = parse(interpretRequestSchema, input);
  const result = await cached(deps, `interpret:${query.toLowerCase()}`, () =>
    deps.client.companies.count({ semantic: { query } }),
  );
  return ok<InterpretResponse>({
    query,
    count: result.count,
    total: result.total,
    interpretation: result.interpretation ?? null,
  });
};

/** POST /api/count: a free filter count. */
export const count: Handler = async (input, deps) => {
  const { filter } = parse(countRequestSchema, input);
  return ok<CountResponse>(await countFilter(deps, filter));
};

/** POST /api/grid: up to 8 x 8 free counts, 4 at a time. */
export const grid: Handler = async (input, deps) => {
  const { filter, rows, columns } = parse(gridRequestSchema, input);
  return ok<GridResponse>(await computeGrid(filter, rows, columns, (cell) => countWithBackoff(deps, cell)));
};

async function previewsAllowed(deps: Deps): Promise<boolean> {
  const me = await cached(deps, 'me', () => deps.client.me());
  return me.capabilities.previews;
}

/** GET /api/capabilities: only the one flag the UI needs, never the raw `me()` payload. */
export const capabilities: Handler = async (_input, deps) =>
  ok<CapabilitiesResponse>({ previews: await previewsAllowed(deps) });

/** POST /api/preview: up to 25 matching companies for free, when the plan has previews. */
export const preview: Handler = async (input, deps) => {
  const { filter } = parse(previewRequestSchema, input);
  if (!(await previewsAllowed(deps))) {
    return ok<PreviewResponse>({ available: false, reason: "This API key's plan does not include free previews." });
  }
  try {
    const result = await deps.client.companies.preview({ filter });
    const items: SampleCompany[] = result.items.map((item) => ({
      id: item.id,
      name: item.name ?? 'Unnamed company',
      logoUrl: item.logoUrl,
      industry: item.industry ?? null,
      domain: null,
      country: null,
      employees: null,
    }));
    return ok<PreviewResponse>({ available: true, total: result.total, items });
  } catch (error) {
    // `me()` can report previews while the endpoint still refuses this key.
    if (error instanceof PermissionDeniedError || error instanceof PaymentRequiredError) {
      return ok<PreviewResponse>({
        available: false,
        reason: `CompanyEnrich refused the free preview for this key (${error.status}), although the account reports previews.`,
      });
    }
    throw error;
  }
};

/** True when the API answered with a client error, which means the search was not billed. */
function definitelyNotBilled(error: unknown): boolean {
  return error instanceof ApiError && !(error instanceof ServerError) && error.status < 500;
}

/**
 * POST /api/search: the paid sample. Off unless ENABLE_PAID_SEARCH=true. Every
 * request must confirm, is capped at 10 results, is throttled per client address,
 * and reserves its worst-case cost from the daily budget before calling the API.
 */
export const search: Handler = async (input, deps, { clientIp }) => {
  if (!deps.paidSearchEnabled) {
    return {
      status: 403,
      body: { error: 'Paid search is turned off on this server. Set ENABLE_PAID_SEARCH=true to allow it.' },
    };
  }
  const { filter, pageSize } = parse(searchRequestSchema, input);

  const slot = deps.paidSearchThrottle.take(clientIp);
  if (!slot.allowed) {
    const minutes = Math.max(1, Math.ceil(slot.retryAfterMs / 60_000));
    return { status: 429, body: { error: `Too many paid searches from this address. Try again in ${minutes} min.` } };
  }

  const reservation = deps.budget.reserve(searchCredits('filter', pageSize));
  if (!reservation) {
    return {
      status: 429,
      body: {
        error: `Today's paid-search budget is used up (${deps.budget.remaining()} of ${deps.budget.maxPerDay} credits left). It resets at 00:00 UTC.`,
      },
    };
  }

  let charged = reservation.credits;
  let paidCallSent = false;
  try {
    // A free count first: an empty paid search still costs one credit.
    const { count: matches } = await countFilter(deps, filter);
    if (matches === 0) {
      charged = 0;
      return ok<SearchResponse>({ items: [], matches, credits: 0, skipped: true });
    }
    paidCallSent = true;
    const page = await deps.client.companies.search({ filter, pageSize });
    const items: SampleCompany[] = page.items.map((company) => ({
      id: company.id,
      name: company.name ?? company.domain,
      logoUrl: company.logoUrl,
      industry: company.industry ?? null,
      domain: company.domain,
      country: company.location?.country?.name ?? null,
      employees: company.employees ?? null,
    }));
    charged = searchCredits('filter', items.length);
    return ok<SearchResponse>({ items, matches, credits: charged, skipped: false });
  } catch (error) {
    // Keep the reservation when the paid call's outcome is unknown (timeouts, 5xx): it may have been billed.
    if (!paidCallSent || definitelyNotBilled(error)) charged = 0;
    throw error;
  } finally {
    deps.budget.settle(reservation, charged);
  }
};

/** GET /api/autocomplete/[kind]: free suggestions for the builder's search boxes. */
export const autocomplete: Handler = async (input, deps) => {
  const { kind, q, countries } = parse(autocompleteRequestSchema, input);
  const geo = { query: q, pageSize: 10, ...(countries.length > 0 && { countryCodes: countries }) };
  const place = (name: string, code?: string | null) => (code ? `${name}, ${countryName(code)}` : name);

  const items = await cached(deps, `ac:${kind}:${q.toLowerCase()}:${countries.join(',')}`, async (): Promise<Suggestion[]> => {
    switch (kind) {
      case 'technologies':
        return (await deps.client.technologies.autocomplete(q)).items.map((value) => ({ value, label: value }));
      case 'keywords':
        return (await deps.client.keywords.autocomplete(q)).items.map((value) => ({ value, label: value }));
      case 'countries':
        return (await deps.client.geo.searchCountries({ query: q, pageSize: 10 })).items.map((c) => ({
          value: c.code,
          label: c.name,
        }));
      case 'states':
        return (await deps.client.geo.searchStates(geo)).items.map((s) => ({ value: s.id, label: place(s.name, s.countryCode) }));
      case 'cities':
        return (await deps.client.geo.searchCities(geo)).items.map((c) => ({ value: c.id, label: place(c.name, c.countryCode) }));
    }
  });
  return ok<AutocompleteResponse>({ items });
};

/** GET /api/regions: region ids for the region filter. */
export const regions: Handler = async (_input, deps) => {
  const result = await cached(deps, 'regions', () => deps.client.geo.regions());
  return ok<RegionsResponse>({
    items: result.items.map((region) => ({ value: region.id, label: region.name, parent: region.parentId ?? null })),
  });
};

/** GET /api/industries: industries and their NAICS prefixes (v2 filters by `naicsCodes`). */
export const industries: Handler = async (_input, deps) => {
  const result = await cached(deps, 'industries', () => deps.client.industries.list());
  return ok<IndustriesResponse>({ items: result.items.map(({ name, naicsCodes }) => ({ name, naicsCodes })) });
};
