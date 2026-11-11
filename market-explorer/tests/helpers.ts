import { CompanyEnrich } from '@companyenrich/sdk';
import { LruCache } from '@/lib/cache';
import type { Deps } from '@/lib/handlers';
import { CreditBudget, SlidingWindowLimiter } from '@/lib/spend';
import { UpstreamLimiter, limitedFetch } from '@/lib/upstream';

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Route = (call: Call) => { status?: number; body: unknown };

/**
 * A real SDK client whose `fetch` is answered by `routes`, keyed by
 * "METHOD /path". Every request is recorded in `calls`, and `stats.peak` is the
 * most requests ever in flight at once. Optional `limiter` and `delayMs` model
 * the production transport and a slow API. No network.
 */
export function fakeClient(routes: Record<string, Route>, limiter?: UpstreamLimiter, delayMs = 0) {
  const calls: Call[] = [];
  const stats = { inFlight: 0, peak: 0 };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    stats.inFlight++;
    stats.peak = Math.max(stats.peak, stats.inFlight);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    stats.inFlight--;
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const call: Call = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    const { status = 200, body } = route ? route(call) : { status: 404, body: { title: 'Not Found' } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const transport = limiter ? limitedFetch(limiter, fetchImpl as typeof fetch) : (fetchImpl as typeof fetch);
  const client = new CompanyEnrich({ apiKey: 'test-key', fetch: transport, maxRetries: 0 });
  return { client, calls, stats };
}

export function testDeps(client: CompanyEnrich, overrides: Partial<Deps> = {}): Deps {
  return {
    client,
    cache: new LruCache<unknown>(100, 60_000),
    paidSearchEnabled: true,
    budget: new CreditBudget(1_000),
    paidSearchThrottle: new SlidingWindowLimiter(1_000, 60 * 60_000),
    rateLimitBackoffMs: 0,
    ...overrides,
  };
}

export const ME_WITH_PREVIEWS = {
  userId: 'user-1',
  credits: { used: 10, total: 100 },
  capabilities: {
    lists: true,
    previews: true,
    companySearchLimit: 100_000,
    companySearchAsyncLimit: 100_000,
    peopleSearchLimit: 100_000,
    searchTermLimit: 1_000,
  },
};
