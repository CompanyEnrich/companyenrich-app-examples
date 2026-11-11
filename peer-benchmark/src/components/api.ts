// Browser-side calls to this app's own route handlers. The CompanyEnrich key
// stays on the server; these only ever see domains and computed results.
import type { BenchmarkEstimate, BenchmarkRun } from '@/server/benchmark-service';
import type { SuggestedPeer } from '@/server/state';
import type { SuggestEstimate, SuggestRun } from '@/server/suggest-service';

export type { BenchmarkEstimate, BenchmarkRun, SuggestedPeer, SuggestEstimate };

export interface CompanyOption {
  domain: string;
  name: string;
  logoUrl: string | null;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Credits a paid request spent before it failed. */
    readonly creditsCharged: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const fields = body && typeof body === 'object' ? (body as { error?: unknown; creditsCharged?: unknown }) : {};
    const message = typeof fields.error === 'string' ? fields.error : `Request failed with status ${response.status}.`;
    const charged = typeof fields.creditsCharged === 'number' ? fields.creditsCharged : 0;
    throw new RequestError(message, response.status, charged);
  }
  return body as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

interface Picks {
  company: string;
  peers: string[];
}

export const api = {
  autocomplete: (query: string, signal?: AbortSignal) =>
    request<{ items: CompanyOption[] }>(`/api/autocomplete?q=${encodeURIComponent(query)}`, { signal }),

  estimateSuggestions: (picks: Picks & { count: number }) =>
    post<{ mode: 'estimate'; estimate: SuggestEstimate }>('/api/suggest', picks),

  suggest: (picks: Picks & { count: number; maxCredits: number }) =>
    post<{ mode: 'result' } & SuggestRun>('/api/suggest', { ...picks, confirm: true }),

  estimateBenchmark: (picks: Picks) => post<{ mode: 'estimate'; estimate: BenchmarkEstimate }>('/api/benchmark', picks),

  benchmark: (picks: Picks & { maxCredits: number }) =>
    post<{ mode: 'result' } & BenchmarkRun>('/api/benchmark', { ...picks, confirm: true }),
};
