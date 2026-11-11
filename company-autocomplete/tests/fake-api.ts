// A stand-in for the CompanyEnrich API, injected into the SDK as its `fetch`.
// It records every call, so tests can assert when the cache avoided one.

export interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeApiRoutes {
  autocomplete?: (query: string) => Reply;
  enrich?: (domain: string) => Reply;
}

export const STRIPE = {
  id: '0192577c-1d7a-715c-a5b7-1b9b530445e0',
  name: 'Stripe',
  legalName: 'Stripe, Inc.',
  domain: 'stripe.com',
  website: 'https://stripe.com',
  logoUrl: 'https://api.companyenrich.com/companies/logo/0192577c-1d7a-715c-a5b7-1b9b530445e0',
  description: 'Financial infrastructure for the internet.',
  type: 'private',
  foundedYear: 2010,
  employees: '5K-10K',
  revenue: 'over-1b',
  industry: 'Financial Services',
  industries: ['Financial Services', 'Software'],
  categories: ['b2b', 'saas'],
  location: {
    country: { code: 'US', name: 'United States' },
    state: { id: 1, name: 'California', code: 'US-CA' },
    city: { id: 2, name: 'South San Francisco' },
    address: '354 Oyster Point Blvd',
    phone: '+1 555 0100',
  },
  socials: { linkedinUrl: 'https://www.linkedin.com/company/stripe', twitterUrl: 'https://twitter.com/stripe' },
  updatedAt: '2026-10-01T00:00:00Z',
  financial: { totalFunding: 9_000_000_000, fundingStage: 'series_i' },
  keywords: ['payments'],
  technologies: ['react'],
};

export const STRIPE_SUGGESTIONS = [
  { id: 'a', name: 'Stripe', domain: 'stripe.com', logoUrl: STRIPE.logoUrl },
  { id: 'b', name: 'Stringee', domain: 'stringee.com', logoUrl: 'https://api.companyenrich.com/companies/logo/b' },
  { id: 'c', name: null, domain: 'strike.me', logoUrl: '' },
];

const defaultRoutes: Required<FakeApiRoutes> = {
  autocomplete: (query) => ({ body: { items: query.startsWith('str') ? STRIPE_SUGGESTIONS : [] } }),
  enrich: (domain) =>
    domain === STRIPE.domain
      ? { body: STRIPE }
      : { status: 404, body: { title: 'Not Found', status: 404, detail: `No company found for ${domain}` } },
};

export function createFakeApi(routes: FakeApiRoutes = {}) {
  const calls: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    const reply =
      url.pathname === '/v2/companies/autocomplete'
        ? (routes.autocomplete ?? defaultRoutes.autocomplete)(url.searchParams.get('query') ?? '')
        : url.pathname === '/v2/companies/enrich'
          ? (routes.enrich ?? defaultRoutes.enrich)(url.searchParams.get('domain') ?? '')
          : { status: 404, body: { title: 'Not Found' } };
    const status = reply.status ?? 200;
    return new Response(JSON.stringify(reply.body), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...reply.headers },
    });
  };
  return {
    fetch,
    calls,
    callsTo: (path: 'autocomplete' | 'enrich') => calls.filter((url) => url.pathname === `/v2/companies/${path}`),
  };
}
