import { CompanyEnrich, type Company, type Person } from '@companyenrich/sdk';

/** A fictional company in the fake dataset, with the attributes the filters look at. */
export interface FakeCompany {
  domain: string;
  technologies: string[];
  country: string;
  employees: string;
  categories?: string[];
  growing?: boolean;
  funded?: boolean;
}

/** A fictional person; `domain` is the current employer. */
export interface FakePerson {
  domain: string;
  department: string;
  seniority: string;
  position: string;
}

type Body = Record<string, any>;

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Body | undefined;
}

export interface FakeApiOptions {
  companies?: FakeCompany[];
  people?: FakePerson[];
  technologies?: string[];
  /**
   * Simulates API errors: return an HTTP status to fail this call. `nth` counts earlier calls to
   * the same path, so `nth === 1` fails the second call.
   */
  fail?: (call: Call, nth: number) => number | undefined;
  /** Delay in milliseconds before answering a call, to keep concurrent calls in flight. */
  latency?: (call: Call) => number;
  /** Make a company search return fewer results than requested, to simulate a stale count. */
  searchLimit?: number;
}

export const TECHNOLOGIES = ['zendesk', 'intercom', 'hubspot', 'salesforce', 'salesforce service cloud', 'salesforce account engagement'];

const company = (domain: string, extra: Partial<FakeCompany> = {}): FakeCompany => ({
  domain,
  technologies: ['zendesk'],
  country: 'US',
  employees: '51-200',
  ...extra,
});

/** Two tier-1, two tier-2 and three tier-3 targets, plus companies the filters must exclude. */
export const COMPANIES: FakeCompany[] = [
  company('alpha.example', { growing: true, funded: true }),
  company('bravo.example', { growing: true, funded: true, country: 'GB' }),
  company('charlie.example', { growing: true }),
  company('delta.example', { growing: true, employees: '201-500' }),
  company('echo.example', { funded: true }),
  company('foxtrot.example'),
  company('golf.example', { country: 'DE' }),
  company('hotel.example', { technologies: ['zendesk', 'intercom'], growing: true, funded: true }), // already runs ours
  company('india.example', { technologies: ['hubspot'], growing: true }), // does not run the competitor
];

export const PEOPLE: FakePerson[] = [
  { domain: 'alpha.example', department: 'operations/customer-service-support', seniority: 'director', position: 'Director of Support' },
  { domain: 'alpha.example', department: 'sales/customer-success', seniority: 'manager', position: 'Customer Success Manager' },
  { domain: 'bravo.example', department: 'operations', seniority: 'vp', position: 'VP Operations' }, // fallback only
  { domain: 'charlie.example', department: 'operations/customer-service-support', seniority: 'head', position: 'Head of Support' },
  { domain: 'delta.example', department: 'engineering-technical', seniority: 'senior', position: 'Engineer' }, // matches nothing
];

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Evaluates the subset of the v2 company filter this app sends. */
function matchesCompany(c: FakeCompany, filter: Body = {}): boolean {
  const tech = filter.technologies;
  if (tech?.all && !tech.all.every((t: string) => c.technologies.includes(t))) return false;
  if (tech?.notIn && tech.notIn.some((t: string) => c.technologies.includes(t))) return false;
  if (filter.country && !asList(filter.country).includes(c.country)) return false;
  if (filter.employees && !asList(filter.employees).includes(c.employees)) return false;
  if (filter.categories?.in && !filter.categories.in.some((cat: string) => c.categories?.includes(cat))) return false;
  if (filter.workforceGrowth && !c.growing) return false;
  if ((filter.fundingYear || filter.fundingAmount) && !c.funded) return false;
  if (filter.domain?.notIn?.includes(c.domain)) return false;
  return true;
}

function matchesPerson(p: FakePerson, filter: Body = {}): boolean {
  if (filter.domain && !asList(filter.domain).includes(p.domain)) return false;
  const departments = asList(filter.department) as string[];
  if (departments.length > 0 && !departments.some((d) => p.department === d || p.department.startsWith(`${d}/`))) return false;
  if (filter.seniority && !asList(filter.seniority).includes(p.seniority)) return false;
  const phrases = asList(filter.position) as string[];
  if (phrases.length > 0 && !phrases.some((phrase) => p.position.toLowerCase().includes(phrase.toLowerCase()))) return false;
  return true;
}

function toCompany(c: FakeCompany, expand: string[] = []): Company {
  return {
    id: `id-${c.domain}`,
    name: c.domain.split('.')[0]!.replace(/^./, (letter) => letter.toUpperCase()),
    domain: c.domain,
    website: `https://${c.domain}`,
    logoUrl: 'https://example.com/logo.png',
    industry: 'Software',
    employees: c.employees as Company['employees'],
    location: { country: { code: c.country, name: c.country } },
    updatedAt: '2026-11-01T00:00:00Z',
    ...(expand.includes('financial') && {
      financial: c.funded
        ? { totalFunding: 30_000_000, fundingRounds: [{ type: 'series_a', amount: '10000000 USD', date: '2024-02-01' }, { type: 'series_b', amount: '20000000 USD', date: '2025-09-15' }] }
        : {},
    }),
  };
}

function toPerson(p: FakePerson, id: number): Person {
  return {
    id,
    name: `Person ${id}`,
    position: p.position,
    seniority: p.seniority as Person['seniority'],
    department: p.department as Person['department'],
    socials: { linkedinUrl: `https://www.linkedin.com/in/person-${id}` },
    experiences: [{ isCurrent: true, isMatched: true, company: { id: `id-${p.domain}`, domain: p.domain } }],
  };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export const PAID_PATHS = new Set(['/v2/companies/search', '/v2/people/search']);

/** A CompanyEnrich client backed by an in-memory fake of the v2 endpoints this app uses. */
export function fakeApi(options: FakeApiOptions = {}) {
  const companies = options.companies ?? COMPANIES;
  const people = options.people ?? PEOPLE;
  const technologies = options.technologies ?? TECHNOLOGIES;
  const calls: Call[] = [];
  let used = 100;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, body };
    const nth = calls.filter((earlier) => earlier.path === call.path).length;
    calls.push(call);

    const failStatus = options.fail?.(call, nth);
    if (failStatus) return json({ title: 'Simulated failure', status: failStatus, detail: 'simulated' }, failStatus);
    const delay = options.latency?.(call) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    switch (url.pathname) {
      case '/v2/me':
        return json({ userId: 'user', credits: { used, total: 1000 }, capabilities: { previews: true, searchTermLimit: 1000 } });
      case '/v2/technologies/autocomplete': {
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        return json({ items: technologies.filter((name) => name.startsWith(query)).slice(0, 10) });
      }
      case '/v2/companies/search/count': {
        const total = companies.filter((c) => matchesCompany(c, body?.filter)).length;
        return json({ count: total, total });
      }
      case '/v2/companies/search': {
        const limit = Math.min(body?.pageSize ?? 10, options.searchLimit ?? Infinity);
        const items = companies.filter((c) => matchesCompany(c, body?.filter)).slice(0, limit).map((c) => toCompany(c, body?.expand));
        used += Math.max(1, items.length) + items.length * (body?.expand?.length ?? 0);
        return json({ items });
      }
      case '/v2/people/search/count': {
        const atCompanies = body?.company ? companies.filter((c) => matchesCompany(c, body.company.filter)).map((c) => c.domain) : undefined;
        const total = people.filter((p) => matchesPerson(p, body?.filter) && (!atCompanies || atCompanies.includes(p.domain))).length;
        return json({ count: total, total });
      }
      case '/v2/people/search': {
        const items = people
          .filter((p) => matchesPerson(p, body?.filter))
          .slice(0, body?.pageSize ?? 10)
          .map((p) => toPerson(p, people.indexOf(p) + 1));
        used += Math.max(1, items.length) * 2;
        return json({ items });
      }
      default:
        return json({ title: 'Not Found', status: 404 }, 404);
    }
  };

  const client = new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries: 0 });
  return {
    client,
    calls,
    /** Credits the fake billed so far. */
    charged: () => used - 100,
    paidCalls: () => calls.filter((call) => PAID_PATHS.has(call.path)),
    callsTo: (path: string) => calls.filter((call) => call.path === path),
  };
}

export const NOW = new Date('2026-11-11T09:30:00Z');
