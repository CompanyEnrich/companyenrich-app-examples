import { FakeUrlFetchApp, type ApiHandler, type FakeReply, type RecordedRequest } from '../harness/fakes.js';
import { createEnvironment, type EnvironmentOptions } from '../harness/load.js';

/** Fictional companies on the reserved .example TLD. Shapes follow the v2 company response. */
export const COMPANIES: Record<string, Record<string, unknown>> = {
  'acme.example': {
    id: 'cmp_acme',
    name: 'Acme',
    domain: 'acme.example',
    website: 'https://acme.example',
    logoUrl: 'https://logos.example/acme.png',
    description: 'Makes everything.',
    type: 'private',
    foundedYear: 1949,
    employees: '1K-5K',
    revenue: '200m-1b',
    industry: 'Manufacturing',
    industries: ['Manufacturing', 'Retail'],
    categories: ['b2b', 'e-commerce'],
    location: {
      country: { code: 'US', name: 'United States' },
      state: { id: 5, name: 'Arizona', code: 'US-AZ' },
      city: { id: 7, name: 'Phoenix' },
      address: null,
    },
    socials: { linkedinUrl: 'https://www.linkedin.com/company/acme-example', twitterUrl: '' },
    updatedAt: '2026-10-01T00:00:00Z',
  },
  'globex.example': {
    id: 'cmp_globex',
    name: 'Globex',
    domain: 'globex.example',
    website: 'https://globex.example',
    logoUrl: 'https://logos.example/globex.png',
    employees: '201-500',
    industry: 'Software Development',
    categories: ['saas'],
    location: { country: { code: 'DE', name: 'Germany' } },
    socials: {},
    updatedAt: '2026-10-01T00:00:00Z',
  },
  'initech.example': {
    id: 'cmp_initech',
    name: 'Initech',
    domain: 'initech.example',
    website: 'https://initech.example',
    logoUrl: 'https://logos.example/initech.png',
    employees: '51-200',
    industry: 'IT Services and IT Consulting',
    location: { country: { code: 'US', name: 'United States' } },
    socials: {},
    updatedAt: '2026-10-01T00:00:00Z',
  },
};

export const COUNTRIES = [
  { code: 'DE', name: 'Germany' },
  { code: 'IN', name: 'India' },
  { code: 'IO', name: 'British Indian Ocean Territory' },
  { code: 'US', name: 'United States' },
];

/** People by company domain. Names are placeholders. */
export const PEOPLE: Record<string, Array<Record<string, unknown>>> = {
  'acme.example': [
    person(1, '<CEO>', 'Chief Executive Officer', 'c-suite', 'acme.example', 'Acme'),
    person(2, '<VP Sales>', 'VP Sales', 'vp', 'acme.example', 'Acme'),
    person(3, '<Head of RevOps>', 'Head of Revenue Operations', 'head', 'acme.example', 'Acme'),
  ],
  'globex.example': [person(4, '<CTO>', 'CTO', 'c-suite', 'globex.example', 'Globex')],
  'initech.example': [],
};

function person(id: number, name: string, position: string, seniority: string, domain: string, company: string) {
  return {
    id,
    name,
    position,
    seniority,
    department: 'sales',
    location: { country: { code: 'US', name: 'United States' } },
    socials: { linkedinUrl: `https://www.linkedin.com/in/person-${id}` },
    experiences: [
      { isCurrent: false, isMatched: false, position: 'Intern', company: { id: 'cmp_old', name: 'Old Co', domain: 'old.example' } },
      { isCurrent: true, isMatched: true, position, company: { id: `cmp_${id}`, name: company, domain } },
    ],
  };
}

const notFound: FakeReply = { status: 404, body: { title: 'Not Found', status: 404, detail: 'Company not found' } };

/**
 * A fake CompanyEnrich v2 API backed by the fixtures above. `overrides` lets
 * a test replace the reply for a path, for example to return an error.
 */
export function fakeApi(overrides: Record<string, ApiHandler> = {}): ApiHandler {
  return (request: RecordedRequest) => {
    const override = overrides[request.path];
    if (override) return override(request);
    switch (`${request.method} ${request.path}`) {
      case 'GET /me':
        return { body: { userId: 'u_1', credits: { used: 10.5, total: 1000 }, capabilities: { previews: true } } };
      case 'GET /companies/enrich': {
        const company = COMPANIES[request.query.get('domain') ?? ''];
        return company ? { body: company } : notFound;
      }
      case 'POST /companies/enrich/batch':
        return {
          body: {
            items: (request.body.domains as string[]).map((domain) =>
              COMPANIES[domain] ? { domain, status: 'found', company: COMPANIES[domain] } : { domain, status: 'not-found' },
            ),
          },
        };
      case 'POST /companies/search/count':
        return { body: { count: 1234, total: 1234 } };
      case 'POST /companies/search': {
        const items = Object.values(COMPANIES)
          .filter((company) => !(request.body.filter?.domain?.notIn ?? []).includes(company.domain))
          .slice(0, request.body.pageSize);
        return { body: { items, scores: Object.fromEntries(items.map((company, i) => [company.id, 0.9 - i / 10])) } };
      }
      case 'POST /people/search/count': {
        const people = PEOPLE[request.body.filter.domain] ?? [];
        return { body: { count: people.length, total: people.length } };
      }
      case 'POST /people/search': {
        const people = PEOPLE[request.body.filter.domain] ?? [];
        return { body: { items: people.slice(0, request.body.pageSize) } };
      }
      case 'POST /geo/countries': {
        const query = String(request.body.query).toLowerCase();
        return { body: { items: COUNTRIES.filter((country) => country.name.toLowerCase().includes(query)) } };
      }
      default:
        return { status: 404, body: { title: 'Unknown route in fake API' } };
    }
  };
}

/** A loaded script talking to the fake API, with an API key already saved. */
export function setup(options: Partial<EnvironmentOptions> & { overrides?: Record<string, ApiHandler> } = {}) {
  const urlFetch = new FakeUrlFetchApp(fakeApi(options.overrides));
  const environment = createEnvironment({ apiKey: 'test-key', ...options, urlFetch });
  return { ...environment, urlFetch };
}

/** A problem+json error reply. */
export function problem(status: number, detail: string, headers: Record<string, string> = {}): FakeReply {
  return { status, body: { title: `HTTP ${status}`, status, detail }, headers };
}

/** What the sidebar sends when the user clicks the confirm button. */
export function confirm<T extends object>(plan: T): T & { confirmed: true } {
  return { ...plan, confirmed: true };
}
