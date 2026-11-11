import { CompanyEnrich, type Person } from '@companyenrich/sdk';

/**
 * A tiny in-memory CompanyEnrich API. Tests pass its `fetch` to the real SDK, so
 * request building, response parsing and error classes are all exercised offline.
 */
export interface FakeCompany {
  domain: string;
  name: string;
  employees: string | null;
  /** Everyone currently at the company. Counts and searches filter this list. */
  people: Person[];
  /** Workforce department headcounts. Omit to make the workforce endpoint return 404. */
  headcount?: Record<string, number>;
}

export interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Filter = {
  domain?: string;
  seniority?: string[];
  department?: string[];
  position?: { in?: string[]; notIn?: string[] };
  employees?: string[];
};

const contains = (title: string, phrases: string[] = []) => phrases.some((phrase) => title.toLowerCase().includes(phrase.toLowerCase()));

function matches(person: Person, filter: Filter): boolean {
  const current = person.experiences.find((experience) => experience.isCurrent);
  if (filter.domain && current?.company?.domain !== filter.domain) return false;
  if (filter.seniority && !filter.seniority.includes(person.seniority ?? '')) return false;
  if (filter.department && !filter.department.some((d) => person.department === d || person.department?.startsWith(`${d}/`))) return false;
  const title = current?.position ?? '';
  if (filter.position?.in && !contains(title, filter.position.in)) return false;
  if (contains(title, filter.position?.notIn)) return false;
  return true;
}

export interface FakeApiOptions {
  /** Answer every request with this HTTP status. */
  status?: number;
  /** Override the response for the nth call (1-based) to a path; return null for the normal answer. */
  respond?: (path: string, nth: number) => Response | null;
  /** Hold each response this long, so concurrency can be observed. */
  delayMs?: number;
  /** The SDK client's default `maxRetries`. 0 by default so tests stay fast. */
  clientRetries?: number;
}

export function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ title: 'Error', status, detail: 'forced by test' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function fakeApi(companies: FakeCompany[], options: FakeApiOptions = {}) {
  const calls: Call[] = [];
  const callsPerPath = new Map<string, number>();
  let creditsUsed = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return answer(input, init);
    } finally {
      inFlight--;
    }
  };

  function answer(input: Parameters<typeof globalThis.fetch>[0], init: Parameters<typeof globalThis.fetch>[1]): Response {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path: url.pathname, body });
    const nth = (callsPerPath.get(url.pathname) ?? 0) + 1;
    callsPerPath.set(url.pathname, nth);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (options.status) return errorResponse(options.status);
    const override = options.respond?.(url.pathname, nth);
    if (override) return override;

    const filter = (body?.filter ?? {}) as Filter;
    const company = (domain: string | null | undefined) => companies.find((c) => c.domain === domain);

    switch (url.pathname) {
      case '/v2/me':
        return json({ userId: 'u1', credits: { used: creditsUsed, total: 1000 }, capabilities: {} });
      case '/v2/companies/autocomplete': {
        const query = url.searchParams.get('query') ?? '';
        return json({ items: companies.filter((c) => c.domain.startsWith(query)).map((c) => ({ id: `id-${c.domain}`, name: c.name, domain: c.domain, logoUrl: '' })) });
      }
      case '/v2/companies/search/count': {
        const found = company(filter.domain);
        const hit = found && found.employees !== null && (filter.employees ?? []).includes(found.employees);
        return json({ count: hit ? 1 : 0, total: hit ? 1 : 0 });
      }
      case '/v2/people/search/count': {
        const people = company(filter.domain)?.people.filter((p) => matches(p, filter)) ?? [];
        return json({ count: people.length, total: people.length });
      }
      case '/v2/people/search': {
        const people = (company(filter.domain)?.people.filter((p) => matches(p, filter)) ?? []).slice(0, Number(body?.pageSize ?? 10));
        creditsUsed += Math.max(1, people.length) * 2;
        return json({ items: people });
      }
      case '/v2/companies/workforce': {
        const found = company(url.searchParams.get('domain'));
        if (!found?.headcount) return json({ title: 'Not Found', status: 404 }, 404);
        creditsUsed += 1;
        return json({
          companyId: 'x', domain: found.domain, observedEmployeeCount: found.people.length, departmentHeadcount: found.headcount,
          unclassifiedHeadcount: 0, historyFrom: '2025-11-01', historyTo: '2026-11-01', history: [],
        });
      }
      case '/v2/positions/autocomplete': {
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        const known = ['head of platform', 'platform engineer', 'vp engineering'];
        return json({ items: known.filter((title) => title.includes(query)) });
      }
      default: {
        const email = url.pathname.match(/^\/v2\/people\/(\d+)\/email$/);
        if (email) {
          creditsUsed += 10;
          return json({ personId: Number(email[1]), domain: url.searchParams.get('domain'), status: 'found', email: 'someone@example.com', certainty: 'high' });
        }
        return json({ title: 'Not Found', status: 404 }, 404);
      }
    }
  }

  return {
    client: new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries: options.clientRetries ?? 0 }),
    fetch,
    calls,
    maxInFlight: () => maxInFlight,
    paidCalls: () => calls.filter((call) => ['/v2/people/search', '/v2/companies/workforce'].includes(call.path) || call.path.endsWith('/email')),
    creditsUsed: () => creditsUsed,
  };
}

let nextId = 1000;

/** Build a person whose current job is at `domain`. */
export function person(domain: string, fields: { seniority: Person['seniority']; department: Person['department']; title: string; start?: string; name?: string }): Person {
  const id = nextId++;
  return {
    id,
    name: fields.name ?? `Person ${id}`,
    position: fields.title,
    seniority: fields.seniority,
    department: fields.department,
    socials: { linkedinUrl: `https://www.linkedin.com/in/example-${id}` },
    experiences: [
      {
        isCurrent: true,
        isMatched: true,
        startDate: fields.start ?? '2022-01-01',
        position: fields.title,
        seniority: fields.seniority,
        department: fields.department,
        company: { id: `id-${domain}`, name: domain, domain },
      },
    ],
  } as Person;
}
