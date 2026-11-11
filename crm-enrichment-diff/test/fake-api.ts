import { readFileSync } from 'node:fs';
import { CompanyEnrich, type Company } from '@companyenrich/sdk';

/** Real CompanyEnrich responses for four public companies, captured from a live run. */
export const fixtureCompanies: Company[] = JSON.parse(
  readFileSync(new URL('./fixtures/companies.json', import.meta.url), 'utf8'),
);

export const fixtureCsvPath = new URL('./fixtures/crm-export.csv', import.meta.url).pathname;
export const exampleMappingPath = new URL('../mapping.example.json', import.meta.url).pathname;
export const exampleRulesPath = new URL('../rules.example.json', import.meta.url).pathname;

export const BATCH_ID = '6f1c2a9e-0000-4000-8000-000000000001';

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export interface FakeApiOptions {
  /** Domains the batch endpoint reports as `pending`. */
  pending?: string[];
  /** Status polls that report `running` before the bulk job completes. */
  runningPolls?: number;
  /** Drop the connection after streaming this many bulk records, on the first download only. */
  failStreamAfter?: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake CompanyEnrich API behind an injected `fetch`, so tests exercise the real SDK
 * (URLs, request bodies, NDJSON streaming, polling) with no network and no key.
 */
export function fakeApi(companies: Company[] = fixtureCompanies, options: FakeApiOptions = {}) {
  const byDomain = new Map(companies.map((company) => [company.domain, company]));
  const calls: RecordedCall[] = [];
  let bulkDomains: string[] = [];
  let polls = 0;
  let downloads = 0;

  const batchStatus = (status: string) => {
    const found = bulkDomains.filter((domain) => byDomain.has(domain)).length;
    const done = status === 'completed';
    return {
      id: BATCH_ID,
      kind: 'companies.enrich.bulk',
      status,
      progress: {
        total: bulkDomains.length,
        pending: 0,
        running: done ? 0 : bulkDomains.length,
        succeeded: done ? found : 0,
        failed: done ? bulkDomains.length - found : 0,
        unknown: 0,
        cancelled: 0,
      },
      creditsCharged: done ? found : 0,
      createdAt: '2026-11-11T00:00:00Z',
      statusUrl: `https://api.companyenrich.com/v2/batches/${BATCH_ID}`,
      resultsUrl: `https://api.companyenrich.com/v2/companies/enrich/bulk/${BATCH_ID}/results`,
      rawResultsUrl: `https://api.companyenrich.com/v2/batches/${BATCH_ID}/results`,
    };
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });

    if (url.pathname === '/v2/me') {
      return json({ userId: 'user', credits: { used: 100, total: 1000 }, capabilities: {} });
    }
    if (method === 'POST' && url.pathname === '/v2/companies/enrich/batch') {
      const items = (body.domains as string[]).map((domain) => {
        const company = byDomain.get(domain);
        if (company) return { domain, status: 'found', company };
        return { domain, status: options.pending?.includes(domain) ? 'pending' : 'not-found' };
      });
      return json({ items });
    }
    if (method === 'POST' && url.pathname === '/v2/companies/enrich/bulk') {
      bulkDomains = body.domains;
      return json(batchStatus('pending'), 202);
    }
    if (url.pathname === `/v2/batches/${BATCH_ID}`) {
      polls++;
      return json(batchStatus(polls > (options.runningPolls ?? 1) ? 'completed' : 'running'));
    }
    if (url.pathname === `/v2/companies/enrich/bulk/${BATCH_ID}/results`) {
      const records = bulkDomains.map((domain, index) => {
        const company = byDomain.get(domain);
        return company
          ? { index, domain, statusCode: 200, state: 'succeeded', success: true, company }
          : { index, domain, statusCode: 404, state: 'failed', success: false, error: { title: 'Not Found' } };
      });
      const lines = records.map((record) => new TextEncoder().encode(`${JSON.stringify(record)}\n`));
      const failAfter = downloads++ === 0 ? (options.failStreamAfter ?? Infinity) : Infinity;
      let sent = 0;
      // One line per pull, so a simulated dropped connection arrives after the lines already read.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const line = lines[sent];
          if (sent >= failAfter) controller.error(new TypeError('terminated'));
          else if (line) controller.enqueue(line);
          else controller.close();
          sent++;
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
    }
    return json({ title: 'Not Found', status: 404 }, 404);
  };

  return {
    client: new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries: 0 }),
    calls,
    /** Calls that can spend credits: synchronous batch enrichment and bulk job creation. */
    paidCalls: () =>
      calls.filter(
        (call) => call.method === 'POST' && ['/v2/companies/enrich/batch', '/v2/companies/enrich/bulk'].includes(call.path),
      ),
  };
}

/** A minimal company for tests that need many distinct domains. */
export function syntheticCompany(index: number): Company {
  return {
    id: `id-${index}`,
    name: `Company ${index}`,
    domain: `company-${index}.example`,
    website: `https://company-${index}.example`,
    logoUrl: 'https://api.companyenrich.com/companies/logo/id',
    employees: '51-200',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}
