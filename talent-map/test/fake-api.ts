import { CompanyEnrich, type CompanyWorkforce, type Person } from '@companyenrich/sdk';

// An in-memory fake of the v2 endpoints this app uses, plugged into the real SDK through its
// `fetch` option. Every person and company here is fictional.

type Body = Record<string, any>;

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Body | undefined;
}

export function makePerson(id: number, company: { id: string; name: string; domain: string }, joined = '2021-03-01'): Person {
  return {
    id,
    name: `Candidate ${id}`,
    position: 'Senior Data Engineer | Spark | Snowflake',
    seniority: 'senior',
    department: 'engineering-technical/data-science',
    location: { country: { code: 'US', name: 'United States' }, address: 'Austin, Texas, United States' },
    socials: { linkedinUrl: `https://www.linkedin.com/in/candidate-${id}` },
    experiences: [
      { startDate: '2023-06-01', isCurrent: true, isMatched: true, position: 'Senior Data Engineer', company },
      { startDate: joined, endDate: '2023-06-01', isCurrent: false, isMatched: false, position: 'Data Engineer', company },
      { startDate: '2017-01-01', endDate: joined, isCurrent: false, isMatched: false, position: 'Analyst', company: { id: 'co-old', name: 'Old Co' } },
    ],
  };
}

export const COMPANIES = {
  alpha: { id: 'co-alpha', name: 'Alpha Payments', domain: 'alpha.example' },
  beta: { id: 'co-beta', name: 'Beta Ledger', domain: 'beta.example' },
  gamma: { id: 'co-gamma', name: 'Gamma Cards', domain: 'gamma.example' },
};

/** Five candidates: two at Alpha, two at Beta, one at Gamma. */
export const PEOPLE: Person[] = [
  makePerson(1, COMPANIES.alpha),
  makePerson(2, COMPANIES.beta),
  makePerson(3, COMPANIES.alpha),
  makePerson(4, COMPANIES.gamma),
  makePerson(5, COMPANIES.beta),
];

export function makeWorkforce(companyId: string, engineeringNow: number, engineeringThen: number): CompanyWorkforce {
  const snapshot = (date: string, engineeringTechnical: number) => ({
    date,
    observedEmployeeCount: engineeringTechnical * 3,
    departmentHeadcount: { engineeringTechnical, sales: 10 },
    unclassifiedHeadcount: 0,
  });
  return {
    companyId,
    domain: `${companyId}.example`,
    observedEmployeeCount: engineeringNow * 3,
    departmentHeadcount: { engineeringTechnical: engineeringNow, sales: 10 },
    unclassifiedHeadcount: 0,
    historyFrom: '2025-12-01',
    historyTo: '2026-12-01',
    history: [snapshot('2026-11-01', engineeringNow), snapshot('2026-06-01', engineeringThen + 1), snapshot('2025-12-01', engineeringThen)],
  };
}

/** Matching people per company id, used to rank companies: Beta holds the most, then Gamma, then Alpha. */
const COMPANY_POOLS: Record<string, number> = { 'co-alpha': 4, 'co-beta': 30, 'co-gamma': 12 };

/** Default free people count: shrinks with each filter so every step of the funnel is distinct. */
export function defaultPeopleCount(body: Body): number {
  const filter = body.filter ?? {};
  if (filter.companyId) return COMPANY_POOLS[filter.companyId] ?? 0;
  let total = 1000;
  if (filter.department) total = 960;
  if (body.company) total = Math.round(total / 10);
  if (filter.seniority) {
    const perLevel: Record<string, number> = { senior: 40, manager: 12, director: 3 };
    total = (filter.seniority as string[]).reduce((sum, level) => sum + (perLevel[level] ?? 0), 0);
  }
  if (filter.currentCompanyStartDate) total = Math.round(total / 2);
  return total;
}

export interface FakeApiOptions {
  positions?: Record<string, string[]>;
  technologies?: Record<string, string[]>;
  peopleCount?: (body: Body) => number;
  companyCount?: number;
  people?: Person[];
  /** Workforce responses by company id; a missing id answers 404. */
  workforce?: Record<string, CompanyWorkforce>;
  /** Error statuses the workforce endpoint returns for these company ids, e.g. 500 or 429. */
  workforceErrors?: Record<string, number>;
  /** SDK retries; 0 by default so failing tests stay fast. */
  maxRetries?: number;
  /** `me()` answers 500 after this many successful calls. */
  meFailsAfter?: number;
}

const PAID_PATHS = new Set(['/v2/people/search', '/v2/companies/workforce']);

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export function fakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = [];
  const positions = options.positions ?? { 'data engineer': ['Data Engineer', 'Senior Data Engineer', 'Lead Data Engineer'] };
  const technologies = options.technologies ?? { snowflake: ['snowflake'], dbt: [] };
  const peopleCount = options.peopleCount ?? defaultPeopleCount;
  const people = options.people ?? PEOPLE;
  const workforce = options.workforce ?? {
    'co-beta': makeWorkforce('co-beta', 120, 100),
    'co-gamma': makeWorkforce('co-gamma', 40, 50),
    'co-alpha': makeWorkforce('co-alpha', 20, 20),
  };
  let used = 100;
  let meCalls = 0;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    const query = Object.fromEntries(url.searchParams);
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, query, body });

    switch (url.pathname) {
      case '/v2/me':
        if (options.meFailsAfter !== undefined && ++meCalls > options.meFailsAfter) return json({ title: 'Server Error', status: 500 }, 500);
        return json({ userId: 'user', credits: { used, total: 1000 }, capabilities: { previews: true } });
      case '/v2/positions/autocomplete':
        return json({ items: positions[query.query ?? ''] ?? [] });
      case '/v2/technologies/autocomplete':
        return json({ items: technologies[query.query ?? ''] ?? [] });
      case '/v2/companies/search/count': {
        const total = options.companyCount ?? 250;
        return json({ count: total, total, ...(body?.semantic ? { interpretation: { filter: { country: { in: ['US'] } } } } : {}) });
      }
      case '/v2/people/search/count': {
        const total = peopleCount(body ?? {});
        return json({ count: Math.min(total, 100_000), total });
      }
      case '/v2/people/search': {
        const items = people.slice(0, body?.pageSize ?? 10);
        used += Math.max(1, items.length) * 2;
        return json({ items });
      }
      case '/v2/companies/workforce': {
        const status = options.workforceErrors?.[query.id ?? ''];
        if (status) return json({ title: 'Error', status }, status);
        const found = workforce[query.id ?? ''];
        if (!found) return json({ title: 'Not Found', status: 404 }, 404);
        used += 1;
        return json(found);
      }
      default:
        return json({ title: 'Not Found', status: 404 }, 404);
    }
  };

  const client = new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries: options.maxRetries ?? 0 });
  return {
    client,
    calls,
    paidCalls: () => calls.filter((call) => PAID_PATHS.has(call.path)),
    callsTo: (path: string) => calls.filter((call) => call.path === path),
  };
}
