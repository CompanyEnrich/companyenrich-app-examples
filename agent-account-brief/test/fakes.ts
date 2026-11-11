import { CompanyEnrich } from '@companyenrich/sdk';
import { CreditBudget } from '../src/lib/budget';
import { createToolContext, type ToolContext } from '../src/lib/tools';

// A fake CompanyEnrich API for tests: a fetch that routes "METHOD /path" to handlers.
// The real SDK runs on top of it, so request building and error mapping are exercised too.
// All companies and people here are fictional.

export const NOW = new Date('2026-11-11T09:00:00Z');

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

export interface FakeResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A handler may throw to simulate a dropped connection. */
export type Routes = Record<string, (request: FakeRequest) => FakeResponse>;

export const ok = (body: unknown): FakeResponse => ({ status: 200, body });
export const problem = (status: number, detail: string): FakeResponse => ({
  status,
  body: { type: 'about:blank', title: detail, status, detail },
});

/** `maxRetries` defaults to 0 to keep tests fast; pass the SDK default (2) to test retry behavior. */
export function fakeApi(routes: Routes, { maxRetries = 0 }: { maxRetries?: number } = {}) {
  const requests: FakeRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const request: FakeRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const route = routes[`${method} ${url.pathname}`];
    const reply = route ? route(request) : problem(404, `No fake route for ${method} ${url.pathname}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  const client = new CompanyEnrich({ apiKey: 'test', fetch: fetch as typeof globalThis.fetch, maxRetries });
  /** Requests to one route, e.g. calls('POST /v2/people/search'). */
  const calls = (key: string) => requests.filter((request) => `${request.method} ${request.path}` === key);
  return { client, requests, calls };
}

export function testContext(client: CompanyEnrich, maxCredits = 40, dryRun = false): ToolContext {
  return createToolContext({ client, budget: new CreditBudget(maxCredits), dryRun, now: () => NOW });
}

export const ACME = {
  id: '00000000-0000-0000-0000-00000000acme',
  name: 'Acme Cloud',
  legalName: 'Acme Cloud Inc',
  domain: 'acme.example',
  website: 'https://acme.example',
  logoUrl: 'https://api.companyenrich.com/companies/logo/acme',
  description: 'Acme Cloud sells usage-based billing software to SaaS companies.',
  type: 'private',
  foundedYear: 2016,
  employees: '201-500',
  revenue: '10m-50m',
  industry: 'Software',
  industries: ['Software'],
  categories: ['b2b', 'saas'],
  location: {
    country: { code: 'US', name: 'United States' },
    state: { id: 1, name: 'Texas', code: 'TX' },
    city: { id: 2, name: 'Austin' },
    address: '1 Example Way',
    phone: '+1 555 0100',
  },
  socials: { linkedinUrl: 'https://www.linkedin.com/company/acme-cloud-example' },
  updatedAt: '2026-11-01T00:00:00Z',
};

const FINANCIAL = {
  totalFunding: 60000000,
  fundingStage: 'series_b',
  fundingDate: '2025-06-15T00:00:00',
  fundingRounds: [
    { date: '2022-03-01T00:00:00', amount: '20000000 USD', type: 'Series A', investors: 'Seed Fund Example' },
    { date: '2025-06-15T00:00:00', amount: '40000000 USD', type: 'Series B', investors: 'Example Ventures', url: 'https://example.com/b' },
  ],
};

const TECHNOLOGIES = ['Salesforce', 'HubSpot', 'Snowflake', 'React', 'Sentry', 'Segment', 'Stripe'];

const departments = (engineering: number, sales: number, marketing: number) => ({
  cSuite: 6,
  productManagement: 12,
  engineeringTechnical: engineering,
  design: 0,
  finance: 9,
  humanResources: 8,
  marketing,
  operations: 10,
  sales,
});

export const WORKFORCE = {
  companyId: ACME.id,
  domain: ACME.domain,
  observedEmployeeCount: 300,
  employeeCountRange: '201-500',
  departmentHeadcount: departments(123, 60, 30),
  unclassifiedHeadcount: 42,
  historyFrom: '2025-12-01',
  historyTo: '2026-12-01',
  history: [
    { date: '2026-11-01', observedEmployeeCount: 300, departmentHeadcount: departments(123, 60, 30), unclassifiedHeadcount: 42 },
    { date: '2026-05-01', observedEmployeeCount: 280, departmentHeadcount: departments(118, 50, 28), unclassifiedHeadcount: 40 },
    { date: '2025-12-01', observedEmployeeCount: 250, departmentHeadcount: departments(110, 40, 25), unclassifiedHeadcount: 35 },
  ],
};

export function person(id: number, name: string, title: string, seniority: string, department: string, startDate: string, domain = ACME.domain) {
  return {
    id,
    name,
    firstName: name.split(' ')[0],
    lastName: name.split(' ')[1],
    imageUrl: 'https://example.com/photo.jpg',
    position: `${title} at Acme Cloud`,
    seniority,
    department,
    location: { country: { code: 'US', name: 'United States' }, address: 'Austin, Texas' },
    socials: { linkedinUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(' ', '-')}-example` },
    experiences: [
      {
        startDate,
        isCurrent: true,
        isMatched: true,
        position: title,
        seniority,
        department,
        company: { id: ACME.id, name: 'Acme Cloud', domain },
      },
      {
        startDate: '2012-01-01',
        endDate: '2015-12-01',
        isCurrent: false,
        isMatched: false,
        position: 'Engineer',
        company: { id: 'other', name: 'Old Employer', domain: 'old.example' },
      },
    ],
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

export const EXECUTIVES = [
  person(1, 'Avery Example', 'Chief Executive Officer', 'c-suite', 'c-suite/executive', '2016-01-01'),
  person(2, 'Jordan Sample', 'Chief Technology Officer', 'c-suite', 'c-suite/information-technology-executive', '2026-04-01'),
  person(3, 'Riley Placeholder', 'VP Finance', 'vp', 'finance/finance', '2021-09-01'),
];
export const SALES_LEADERS = [
  person(4, 'Casey Demo', 'VP Sales', 'vp', 'sales/sales', '2024-02-01'),
  person(5, 'Drew Mock', 'Head of Sales Development', 'head', 'sales/inside-sales', '2026-08-01'),
];
export const ENGINEERING_LEADERS = [person(6, 'Emery Stub', 'Director of Engineering', 'director', 'engineering-technical/software-development', '2019-05-01')];

export const LOOKALIKES = [
  { ...ACME, id: 'look-1', name: 'Beta Billing', domain: 'beta.example', employees: '51-200' },
  { ...ACME, id: 'look-2', name: 'Gamma Metering', domain: 'gamma.example', employees: '201-500' },
];

/** Which people the fake returns for a people filter. Marketing has nobody, to exercise the free-count skip. */
export function peopleFor(filter: any) {
  const departments: string[] = [filter.department ?? []].flat().concat(filter.department?.in ?? []);
  if (departments.includes('marketing')) return [];
  if (departments.includes('sales')) return SALES_LEADERS;
  if (departments.includes('engineering-technical')) return ENGINEERING_LEADERS;
  return EXECUTIVES;
}

export const ME = (used: number) => ok({
  userId: 'user-test',
  credits: { used, total: 1000 },
  capabilities: { lists: true, previews: false, companySearchLimit: 1000, companySearchAsyncLimit: 1000, peopleSearchLimit: 1000, searchTermLimit: 100 },
});

/** A complete fake API for acme.example. Override routes to test edge cases. */
export function acmeRoutes(overrides: Routes = {}): Routes {
  return {
    'GET /v2/me': () => ME(100),
    'GET /v2/companies/autocomplete': (request) =>
      ok({ items: request.query.get('query') === ACME.domain ? [{ id: ACME.id, name: ACME.name, domain: ACME.domain, logoUrl: ACME.logoUrl }] : [] }),
    'GET /v2/companies/enrich': (request) => {
      if (request.query.get('domain') !== ACME.domain) return problem(404, 'Company not found');
      const expand = request.query.getAll('expand');
      return ok({
        ...ACME,
        ...(expand.includes('financial') ? { financial: FINANCIAL } : {}),
        ...(expand.includes('technologies') ? { technologies: TECHNOLOGIES } : {}),
      });
    },
    'GET /v2/companies/workforce': (request) =>
      request.query.get('domain') === ACME.domain ? ok(WORKFORCE) : problem(404, 'Company not found'),
    'POST /v2/people/search/count': (request) => {
      const count = peopleFor(request.body.filter).length;
      return ok({ count: count * 10, total: count * 10 });
    },
    'POST /v2/people/search': (request) => ok({ items: peopleFor(request.body.filter).slice(0, request.body.pageSize) }),
    'POST /v2/companies/search/count': () => ok({ count: 2031, total: 2031 }),
    'POST /v2/companies/search': (request) =>
      // Scores deliberately not in descending order: the tool must keep the API's order.
      ok({ items: LOOKALIKES.slice(0, request.body.pageSize), scores: { 'look-1': 0.81, 'look-2': 0.86 } }),
    ...overrides,
  };
}
