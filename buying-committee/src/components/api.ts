import type { EmailReveal } from '@/lib/email';
import type { CommitteeMap, CoveragePlan } from '@/lib/types';

export interface CoverageResponse {
  notes: string[];
  source: 'preset' | 'keywords' | 'claude';
  plan: CoveragePlan;
  credits: { used: number; total: number };
}

/** Browser-side calls to our own route handlers. The CompanyEnrich key stays on the server. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export const api = {
  autocomplete: (query: string) => request<{ items: { name: string; domain: string }[] }>(`/api/autocomplete?q=${encodeURIComponent(query)}`),
  coverage: (body: { domains: string[]; preset?: string; description?: string }) =>
    request<CoverageResponse>('/api/coverage', { method: 'POST', body: JSON.stringify(body) }),
  map: (body: { plan: CoveragePlan; workforce: boolean; maxCredits: number; confirmed: true }) =>
    request<{ map: CommitteeMap }>('/api/map', { method: 'POST', body: JSON.stringify(body) }),
  reveal: (body: { personId: string; domain: string; confirmed: true }) =>
    request<{ reveal: EmailReveal }>('/api/reveal', { method: 'POST', body: JSON.stringify(body) }),
};
