import { readFileSync } from 'node:fs';
import { CompanyEnrich } from '@companyenrich/sdk';

export interface FixtureState {
  id: number;
  code: string | null;
  name: string;
  latitude: number | null;
  longitude: number | null;
  companies: number;
  /** Counts per band value, e.g. { "51-200": 27 } or { "10m-50m": 4 }. */
  bands?: Record<string, number>;
}

export interface Fixture {
  country: { code: string; name: string; latitude?: number; longitude?: number };
  countryTotal: number;
  states: FixtureState[];
}

/** Real free counts for examples/icp.json, captured from the live API (see test/fixtures). */
export function loadFixture(code: 'us' | 'de'): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${code}-counts.json`, import.meta.url), 'utf8')) as Fixture;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface FakeApiOptions {
  /** Milliseconds each response waits, so concurrency can be observed. */
  delayMs?: number;
  /** Answer every request to this path with this status. */
  failPath?: { path: string; status: number };
  /** Plan limit applied to `count` (not `total`), like the real API. */
  planLimit?: number;
  /** Answer count requests after the first N with a 500. */
  failCountsAfter?: number;
  /** Answer paid search requests after the first N with a 500. */
  failSearchesAfter?: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, title: string) =>
  new Response(JSON.stringify({ status, title, detail: title }), { status, headers: { 'content-type': 'application/problem+json' } });

/**
 * A CompanyEnrich client backed by an in-memory fake of the v2 endpoints this app uses.
 * Count requests are answered from fixtures; every request is recorded for assertions.
 */
export function createFakeApi(fixtures: Fixture[], options: FakeApiOptions = {}) {
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let countRequests = 0;
  let searchRequests = 0;
  const byCountry = new Map(fixtures.map((fixture) => [fixture.country.code, fixture]));

  function countFor(filter: Record<string, unknown>): number {
    const fixture = byCountry.get(String(filter.country));
    if (!fixture) return 0;
    if (filter.state === undefined) return fixture.countryTotal;
    const ids = Array.isArray(filter.state) ? filter.state : [filter.state];
    const band = [filter.employees, filter.revenue].find((value) => typeof value === 'string') as string | undefined;
    return fixture.states
      .filter((state) => ids.includes(state.id))
      .reduce((sum, state) => sum + (band ? (state.bands?.[band] ?? 0) : state.companies), 0);
  }

  function route(method: string, path: string, body: Record<string, unknown> | undefined): Response {
    if (options.failPath?.path === path) return problem(options.failPath.status, 'Simulated failure');
    if (method === 'GET' && path === '/v2/me') {
      return json({ userId: 'user_test', credits: { used: 10, total: 1000 }, capabilities: { previews: true } });
    }
    const countryMatch = /^\/v2\/geo\/countries\/([A-Z]{2})$/.exec(path);
    if (method === 'GET' && countryMatch) {
      const fixture = byCountry.get(countryMatch[1]!);
      return fixture ? json(fixture.country) : problem(404, 'Country not found');
    }
    if (method === 'POST' && path === '/v2/geo/states') {
      const codes = (body?.countryCodes as string[] | undefined) ?? [];
      const all = codes.flatMap((code) => byCountry.get(code)?.states ?? []);
      const start = Number(body?.cursor ?? 0);
      const pageSize = Number(body?.pageSize ?? 100);
      const items = all.slice(start, start + pageSize).map(({ id, code, name, latitude, longitude }) => ({ id, code, name, latitude, longitude }));
      return json({ items, ...(start + pageSize < all.length ? { nextCursor: String(start + pageSize) } : {}) });
    }
    if (method === 'POST' && path === '/v2/companies/search/count') {
      countRequests++;
      if (options.failCountsAfter !== undefined && countRequests > options.failCountsAfter) return problem(500, 'Simulated outage');
      const total = countFor((body?.filter ?? {}) as Record<string, unknown>);
      return json({ count: Math.min(total, options.planLimit ?? Number.POSITIVE_INFINITY), total });
    }
    if (method === 'POST' && path === '/v2/companies/search') {
      searchRequests++;
      if (options.failSearchesAfter !== undefined && searchRequests > options.failSearchesAfter) return problem(500, 'Simulated outage');
      const filter = (body?.filter ?? {}) as Record<string, unknown>;
      const size = Math.min(Number(body?.pageSize ?? 25), countFor(filter));
      const items = Array.from({ length: size }, (_, index) => ({
        id: `cmp_${index}`,
        name: `Example Co ${index + 1}`,
        domain: `example${index + 1}.com`,
        website: `https://example${index + 1}.com`,
        logoUrl: '',
        updatedAt: '2026-11-01T00:00:00Z',
        employees: '51-200',
        industry: 'Software',
        location: { city: { id: 1, name: 'Springfield' }, state: { id: 1, name: 'Somewhere', code: 'SW' } },
      }));
      return json({ items });
    }
    return problem(404, `No fake route for ${method} ${path}`);
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, path: url.pathname, body });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return route(method, url.pathname, body);
    } finally {
      inFlight--;
    }
  };

  return {
    client: new CompanyEnrich({ apiKey: 'test-key', fetch: fakeFetch, maxRetries: 0 }),
    requests,
    get maxInFlight() {
      return maxInFlight;
    },
    paths: () => requests.map((request) => request.path),
  };
}
