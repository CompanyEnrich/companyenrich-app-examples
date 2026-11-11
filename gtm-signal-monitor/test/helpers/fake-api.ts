import { CompanyEnrich, type Company, type Person } from '@companyenrich/sdk';

type Handler = (body: any, url: URL) => unknown;

export interface RecordedCall {
  route: string;
  body: any;
}

const PAID_ROUTES = new Set(['POST /v2/companies/search', 'POST /v2/people/search', 'POST /v2/companies/enrich/batch']);

/**
 * A CompanyEnrich client backed by in-memory handlers instead of the network.
 * Handlers are keyed by "METHOD /path". Unhandled routes fail the request with 404.
 */
export function createFakeApi(handlers: Record<string, Handler> = {}) {
  const calls: RecordedCall[] = [];
  const routes: Record<string, Handler> = {
    'GET /v2/me': () => ({
      userId: 'test-user',
      credits: { used: 100, total: 1000 },
      capabilities: { lists: true, previews: false, companySearchLimit: 1000, companySearchAsyncLimit: 1000, peopleSearchLimit: 1000, searchTermLimit: 100 },
    }),
    ...handlers,
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    const handler = routes[route];
    if (!handler) return jsonResponse(404, { title: 'Not Found', detail: `No fake handler for ${route}` });
    const result = handler(body, url);
    return result instanceof Response ? result : jsonResponse(200, result);
  };

  return {
    client: new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries: 0 }),
    calls,
    callsTo: (route: string) => calls.filter((call) => call.route === route),
    paidCalls: () => calls.filter((call) => PAID_ROUTES.has(call.route)),
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function fakeCompany(domain: string, overrides: Partial<Company> = {}): Company {
  return {
    id: `id-${domain}`,
    name: domain.split('.')[0]!.replace(/^./, (letter) => letter.toUpperCase()),
    domain,
    website: `https://${domain}`,
    logoUrl: `https://logo.example/${domain}`,
    updatedAt: '2026-11-01T00:00:00Z',
    employees: '201-500',
    revenue: '10m-50m',
    industry: 'Software',
    location: { country: { code: 'US', name: 'United States' }, city: { id: 1, name: 'San Francisco' } },
    ...overrides,
  };
}

export function fakePerson(id: number, domain: string, position: string, startDate: string): Person {
  return {
    id,
    name: `Person ${id}`,
    position,
    socials: { linkedinUrl: `https://www.linkedin.com/in/person-${id}` },
    experiences: [
      {
        isCurrent: true,
        isMatched: true,
        position,
        startDate,
        company: { id: `id-${domain}`, name: domain, domain },
      },
    ],
  };
}

/** For watcher tests that do not look at intermediate progress. */
export const ignoreProgress = () => {};
