import { CompanyEnrich, type Company, type Person } from '@companyenrich/sdk';

// A fake CompanyEnrich API behind an injected `fetch`. Tests register handlers
// per "METHOD /path" and inspect `calls` to prove what was (not) requested.

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

export type FakeReply = { status: number; body: unknown } | Record<string, unknown>;
export type FakeHandler = (request: FakeRequest) => FakeReply;

export interface FakeApi {
  fetch: typeof fetch;
  calls: FakeRequest[];
  /** The most requests that were in flight at the same time. */
  maxConcurrent: () => number;
  client: CompanyEnrich;
  /** Calls to one endpoint, e.g. `api.callsTo('POST /v2/people/search')`. */
  callsTo: (route: string) => FakeRequest[];
}

export function fakeApi(handlers: Record<string, FakeHandler>, options: { delayMs?: number } = {}): FakeApi {
  const calls: FakeRequest[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return respond(input, init);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;

  function respond(input: string | URL | Request, init?: RequestInit): Response {
    const url = new URL(String(input));
    const request: FakeRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(request);
    const handler = handlers[`${request.method} ${request.path}`];
    if (!handler) throw new Error(`Unexpected request: ${request.method} ${request.path}`);
    const reply = handler(request);
    const { status, body } = 'status' in reply && typeof reply.status === 'number' ? (reply as { status: number; body: unknown }) : { status: 200, body: reply };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  return {
    fetch: fetchImpl,
    calls,
    maxConcurrent: () => maxConcurrent,
    client: new CompanyEnrich({ apiKey: 'test-key', fetch: fetchImpl, maxRetries: 0 }),
    callsTo: (route) => calls.filter((call) => `${call.method} ${call.path}` === route),
  };
}

export const notFound: FakeReply = { status: 404, body: { title: 'Not Found', status: 404, detail: 'No company found' } };

/** A company that the shipped config/scoring.json scores as tier A (92.5) in November 2026. */
export function companyFixture(overrides: Partial<Company> = {}): Company {
  return {
    id: 'cmp-acme',
    name: 'Acme Cloud',
    domain: 'acme.example',
    website: 'https://acme.example',
    logoUrl: 'https://logos.example/acme.png',
    type: 'private',
    foundedYear: 2015,
    employees: '501-1K',
    revenue: '10m-50m',
    industry: 'Software',
    categories: ['b2b', 'saas'],
    location: {
      country: { code: 'US', name: 'United States' },
      state: { id: 1, name: 'California', code: 'CA' },
      city: { id: 2, name: 'San Francisco' },
    },
    socials: { linkedinUrl: 'https://www.linkedin.com/company/acme-example' },
    updatedAt: '2026-11-01T00:00:00Z',
    financial: { fundingStage: 'series_f', fundingDate: '2025-09-30T00:00:00', totalFunding: 863_000_000 },
    technologies: ['Amazon SES', 'Marketo', 'Salesforce', 'Next-Js'],
    ...overrides,
  };
}

export function personFixture(id: number, position: string): Person {
  return {
    id,
    name: `Person ${id}`,
    position,
    seniority: 'vp',
    department: 'sales',
    socials: { linkedinUrl: `https://www.linkedin.com/in/person-${id}` },
    experiences: [],
    location: { country: { code: 'US', name: 'United States' } },
  };
}

/** Handlers for the endpoints the pipeline uses, serving `companies` by domain. */
export function companyHandlers(companies: Record<string, Company>, people: Person[] = []): Record<string, FakeHandler> {
  return {
    'GET /v2/companies/enrich': ({ query }) => companies[query.get('domain') ?? ''] ?? notFound,
    'POST /v2/companies/enrich/batch': ({ body }) => ({
      items: (body.domains as string[]).map((domain) =>
        companies[domain] ? { domain, status: 'found', company: companies[domain] } : { domain, status: 'not-found' },
      ),
    }),
    'POST /v2/people/search/count': () => ({ count: people.length, total: people.length }),
    'POST /v2/people/search': ({ body }) => ({ items: people.slice(0, body.pageSize) }),
  };
}
