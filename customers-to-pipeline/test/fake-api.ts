import { readFileSync } from 'node:fs';
import { CompanyEnrich, type Company, type Industry, type Person } from '@companyenrich/sdk';

/** Fixture customers: fictional companies with realistic attributes. */
export const CUSTOMERS: Company[] = JSON.parse(readFileSync(new URL('./fixtures/customers.json', import.meta.url), 'utf8'));
export const INDUSTRIES: Industry[] = JSON.parse(readFileSync(new URL('./fixtures/industries.json', import.meta.url), 'utf8'));
export const INDUSTRY_CODES = new Map(INDUSTRIES.map((industry) => [industry.name, industry.naicsCodes]));

export function makeCompany(domain: string, overrides: Partial<Company> = {}): Company {
  return {
    id: `id-${domain}`,
    name: domain.split('.')[0],
    domain,
    website: `https://${domain}`,
    logoUrl: 'https://example.com/logo.png',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

export function makePerson(index: number, domain: string): Person {
  return {
    id: index,
    name: `Person ${index}`,
    position: 'VP Sales',
    seniority: 'vp',
    department: 'sales',
    socials: { linkedinUrl: `https://www.linkedin.com/in/person-${index}` },
    experiences: [{ isCurrent: true, isMatched: true, company: { id: `id-${domain}`, domain } }],
  };
}

type Body = Record<string, any>;

export interface Call {
  method: string;
  path: string;
  body: Body | undefined;
}

export interface FakeApiOptions {
  /** Companies enrichBatch can find, keyed by domain. Defaults to the fixture customers. */
  known?: Company[];
  /** Free company count. Defaults to 1,234 for any query. */
  companyCount?: (body: Body) => { count: number; total: number };
  /** Free count of a lookalike query. Defaults to 40. */
  lookalikePool?: number;
  /** Lookalike results. Defaults to three fictional accounts. */
  lookalikes?: Company[];
  /** Free people count per company domain. */
  peopleAvailable?: Record<string, number>;
  /** Return a response here to replace the default one, for example an error. */
  override?: (path: string, body: Body | undefined) => Response | undefined;
}

const PAID_PATHS = new Set(['/v2/companies/enrich/batch', '/v2/companies/search', '/v2/people/search']);

export const LOOKALIKES = [
  makeCompany('kilo.example', { industries: ['Software'], employees: '201-500', location: { country: { code: 'US', name: 'United States' } }, foundedYear: 2016 }),
  makeCompany('lima.example', { industries: ['Software'], employees: '5K-10K', location: { country: { code: 'US', name: 'United States' } }, foundedYear: 2011 }),
  makeCompany('mike.example', { industries: ['Retail'], employees: '51-200', location: { country: { code: 'FR', name: 'France' } } }),
];

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A CompanyEnrich client backed by an in-memory fake of the v2 endpoints this app uses. */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = [];
  const known = new Map((options.known ?? CUSTOMERS).map((company) => [company.domain, company]));
  const lookalikes = options.lookalikes ?? LOOKALIKES;
  let used = 100;
  let personId = 0;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    calls.push({ method: init?.method ?? 'GET', path, body });
    const overridden = options.override?.(path, body);
    if (overridden) return overridden;

    switch (path) {
      case '/v2/me':
        return json({ userId: 'user', credits: { used, total: 1000 }, capabilities: {} });
      case '/v2/industries':
        return json({ items: INDUSTRIES });
      case '/v2/companies/enrich/batch': {
        const items = (body?.domains as string[]).map((domain) => {
          const company = known.get(domain);
          return company ? { domain, status: 'found', company } : { domain, status: 'not-found' };
        });
        used += items.filter((item) => item.status === 'found').length * (1 + (body?.expand?.length ?? 0));
        return json({ items });
      }
      case '/v2/companies/search/count':
        if (body?.lookalike) return json({ count: options.lookalikePool ?? 40, total: options.lookalikePool ?? 40 });
        return json(options.companyCount?.(body ?? {}) ?? { count: 1234, total: 1234 });
      case '/v2/companies/search': {
        const items = lookalikes.slice(0, body?.pageSize);
        used += Math.max(1, items.length) * 5;
        return json({ items, scores: Object.fromEntries(items.map((company, index) => [company.id, 0.99 - index / 100])) });
      }
      case '/v2/people/search/count': {
        const count = options.peopleAvailable?.[body?.filter?.domain] ?? 0;
        return json({ count, total: count });
      }
      case '/v2/people/search': {
        const items = Array.from({ length: body?.pageSize ?? 0 }, () => makePerson(++personId, body?.filter?.domain));
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
    paidCalls: () => calls.filter((call) => PAID_PATHS.has(call.path)),
    callsTo: (path: string) => calls.filter((call) => call.path === path),
  };
}
