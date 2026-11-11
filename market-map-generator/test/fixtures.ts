import { CompanyEnrich, type Company } from '@companyenrich/sdk';
import type { Category } from '../src/lib/categorize.ts';
import { parseTheme, type Theme } from '../src/lib/theme.ts';

/** A fictional company with only the fields the app reads. */
export function makeCompany(name: string, description: string, overrides: Partial<Company> = {}): Company {
  const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`;
  return {
    id: `id-${domain}`,
    name,
    domain,
    website: `https://${domain}`,
    logoUrl: `https://api.companyenrich.com/companies/logo/id-${domain}`,
    description,
    industry: 'Software',
    industries: ['Software'],
    categories: ['b2b', 'saas'],
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

/** Nine fictional finance-automation startups in three obvious groups of three. */
export const COMPANIES: Company[] = [
  makeCompany('Ledgerly', 'Ledgerly automates accounts payable: invoice capture, invoice approval and vendor payments.'),
  makeCompany('Closebook', 'Closebook runs the month-end close with bank reconciliation and journal entries.'),
  makeCompany('Forecastly', 'Forecastly is an FP&A copilot for budgeting, forecasting and variance analysis.'),
  makeCompany('Payloop', 'Payloop handles accounts payable with invoice matching, invoice approval and vendor onboarding.'),
  makeCompany('Reconly', 'Reconly automates bank reconciliation, journal entries and the month-end close checklist.'),
  makeCompany('Plannr', 'Plannr gives finance leaders FP&A budgeting, rolling forecasting and scenario planning.'),
  makeCompany('Invoicer', 'Invoicer reads every invoice and routes invoice approval for accounts payable teams.'),
  makeCompany('Tieout', 'Tieout matches bank reconciliation data and drafts journal entries for the month-end close.'),
  makeCompany('Scenaria', 'Scenaria models budgeting scenarios, forecasting and variance analysis for FP&A teams.'),
];

export const GROUPS = {
  payables: ['Ledgerly', 'Payloop', 'Invoicer'],
  close: ['Closebook', 'Reconly', 'Tieout'],
  planning: ['Forecastly', 'Plannr', 'Scenaria'],
};

export function theme(extra = ''): Theme {
  return parseTheme(`title: AI agents for finance teams\nsemantic: AI agents for finance teams\n${extra}`, 'finance');
}

export function category(name: string, companies: Company[], kind: Category['kind'] = 'cluster'): Category {
  return { name, description: `About ${name}`, terms: [], companies, kind };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export interface FakeApiOptions {
  count?: number;
  /** Companies the paid search returns, in order. Defaults to COMPANIES. */
  results?: Company[];
  /** HTTP status for the preview endpoint, e.g. 403 when the plan has no previews. */
  previewStatus?: number;
  /** Makes every call fail with this status, e.g. 401 for a bad key. */
  failWith?: number;
  /** Runs when the paid search is called, before it answers. */
  onSearch?: () => Promise<void>;
}

/** A CompanyEnrich client backed by an in-memory fake of the endpoints this app calls. */
export function fakeCompanyEnrich(options: FakeApiOptions = {}) {
  const calls: Array<{ path: string; body: any; headers: Headers }> = [];
  const results = options.results ?? COMPANIES;

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, headers: new Headers(init?.headers) });
    if (options.failWith) return json({ title: 'Error', status: options.failWith, detail: 'Request failed' }, options.failWith);

    switch (path) {
      case '/v2/companies/search/count':
        return json({ count: options.count ?? 54000, total: options.count ?? 54000, interpretation: { boost: { categories: ['b2b'] } } });
      case '/v2/companies/search/preview':
        if (options.previewStatus) return json({ title: 'Forbidden', status: options.previewStatus }, options.previewStatus);
        return json({ items: results.slice(0, 25).map(({ id, name, logoUrl, updatedAt }) => ({ id, name, logoUrl, updatedAt })), total: 54000 });
      case '/v2/companies/search':
        await options.onSearch?.();
        return json({ items: results.slice(0, body.pageSize) });
      default:
        return json({ title: 'Not Found', status: 404 }, 404);
    }
  };

  return {
    client: new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries: 0 }),
    calls,
    paidCalls: () => calls.filter((call) => call.path === '/v2/companies/search'),
  };
}

/** The bytes of a 1x1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A logo server: serves a PNG for the given URLs and 404 for everything else. Records request headers. */
export function fakeLogoServer(available: string[]) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    if (!available.includes(String(input))) return new Response('not found', { status: 404 });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}
