import type { CompanyOutcome } from '@/lib/benchmark';
import type { DepartmentCounts, Workforce, WorkforcePoint } from '@/lib/departments';

export const WINDOW_START = '2025-12-01';

export function point(date: string, observed: number, departments: DepartmentCounts, unclassified = 0): WorkforcePoint {
  return { date, observedEmployeeCount: observed, departmentHeadcount: departments, unclassifiedHeadcount: unclassified };
}

/** A workforce response whose current numbers are the newest history point (as the API returns them). */
export function workforce(domain: string, history: WorkforcePoint[], current?: WorkforcePoint): Workforce {
  const latest = current ?? history[0]!;
  return {
    domain,
    observedEmployeeCount: latest.observedEmployeeCount,
    departmentHeadcount: latest.departmentHeadcount,
    unclassifiedHeadcount: latest.unclassifiedHeadcount,
    historyFrom: WINDOW_START,
    historyTo: '2026-12-01',
    history,
  };
}

/**
 * A small group with hand-checkable numbers (see insights.test.ts):
 * Acme over-indexes on sales and engineering, under-indexes on marketing,
 * grew 25% while peers barely grew, and one peer has no workforce data.
 */
export const ACME = workforce('acme.com', [
  point('2026-10-01', 200, { engineeringTechnical: 100, sales: 40, marketing: 10, operations: 20, productManagement: 10 }, 20),
  point('2026-03-01', 180, { engineeringTechnical: 90, sales: 40, marketing: 10, operations: 20, productManagement: 6 }, 14),
  point('2025-12-01', 160, { engineeringTechnical: 80, sales: 40, marketing: 10, operations: 20, productManagement: 4 }, 6),
]);

export const BETA = workforce('beta.io', [
  point('2025-12-01', 100, { engineeringTechnical: 30, sales: 10, marketing: 15, operations: 10, productManagement: 5 }, 10),
]);

export const GAMMA = workforce('gamma.com', [
  point('2026-10-01', 400, { engineeringTechnical: 160, sales: 40, marketing: 40, operations: 60, productManagement: 20 }, 40),
  point('2025-12-01', 380, { engineeringTechnical: 150, sales: 40, marketing: 40, operations: 50, productManagement: 20 }, 38),
]);

/** Current numbers but no history at all. */
export const DELTA: Workforce = {
  ...workforce('delta.dev', [point('2026-10-01', 50, { engineeringTechnical: 15, sales: 6, marketing: 5, operations: 5, productManagement: 2 }, 5)]),
  history: [],
};

export function groupOutcomes(): CompanyOutcome[] {
  return [
    { domain: 'acme.com', name: 'Acme', role: 'subject', status: 'ok', workforce: ACME },
    { domain: 'beta.io', name: 'Beta', role: 'peer', status: 'ok', workforce: BETA },
    { domain: 'gamma.com', name: 'Gamma', role: 'peer', status: 'ok', workforce: GAMMA },
    { domain: 'delta.dev', name: 'Delta', role: 'peer', status: 'ok', workforce: DELTA },
    { domain: 'epsilon.ai', name: 'Epsilon', role: 'peer', status: 'excluded', reason: 'no workforce data for this domain' },
  ];
}

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface FakeApiOptions {
  /** Workforce body per domain; a missing domain answers 404. */
  workforce?: Record<string, Workforce>;
  autocomplete?: Record<string, { domain: string; name: string; logoUrl: string }[]>;
  count?: (body: unknown) => { count: number; total: number };
  search?: (body: unknown) => { items: { id: string; domain: string; name: string; logoUrl: string }[]; scores?: Record<string, number> };
  /** Answer every request with this error status instead. */
  failWith?: number;
  /** Fail only the paid workforce call: with an error status, or by dropping the connection. */
  workforceFailure?: number | 'drop';
  /** Fail the workforce call for these domains only, with these statuses. */
  workforceStatusByDomain?: Record<string, number>;
  /** Delay each answer, to observe concurrency. */
  delayMs?: number;
}

function json(status: number, body: unknown): Response {
  const type = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}

/** A stand-in for the CompanyEnrich API, injected as the SDK's `fetch`. Records every call. */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: RecordedCall[] = [];
  const concurrency = { now: 0, peak: 0 };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    concurrency.now += 1;
    concurrency.peak = Math.max(concurrency.peak, concurrency.now);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return answer(input, init);
    } finally {
      concurrency.now -= 1;
    }
  };

  const answer = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams, body });

    if (options.failWith) return json(options.failWith, { title: 'Error', status: options.failWith, detail: 'Fake failure' });
    const failStatus = options.workforceStatusByDomain?.[url.searchParams.get('domain') ?? ''];
    if (failStatus && url.pathname === '/v2/companies/workforce') {
      return json(failStatus, { title: 'Error', status: failStatus, detail: 'Fake failure' });
    }
    if (options.workforceFailure && url.pathname === '/v2/companies/workforce') {
      if (options.workforceFailure === 'drop') throw new TypeError('fetch failed');
      return json(options.workforceFailure, { title: 'Error', status: options.workforceFailure, detail: 'Fake failure' });
    }

    switch (url.pathname) {
      case '/v2/companies/workforce': {
        const found = options.workforce?.[url.searchParams.get('domain') ?? ''];
        return found ? json(200, found) : json(404, { title: 'Not Found', status: 404, detail: 'Company not found' });
      }
      case '/v2/companies/autocomplete':
        return json(200, { items: options.autocomplete?.[url.searchParams.get('query') ?? ''] ?? [] });
      case '/v2/companies/search/count':
        return json(200, options.count?.(body) ?? { count: 0, total: 0 });
      case '/v2/companies/search':
        return json(200, options.search?.(body) ?? { items: [] });
      default:
        return json(404, { title: 'Not Found', status: 404 });
    }
  };

  return {
    fetch,
    calls,
    concurrency,
    paidCalls: () => calls.filter((call) => call.path === '/v2/companies/workforce' || call.path === '/v2/companies/search'),
  };
}
