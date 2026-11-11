import type { CompanyEnrich } from '@companyenrich/sdk';
import { stableKey } from './file-cache.js';
import type { CompanyFilter } from './icp.js';

/** Company search by filter costs 1 credit per returned company; an empty page still costs 1. */
export const CREDITS_PER_SAMPLE_ACCOUNT = 1;

/** Saved sample results are reused for a week, so a re-run never buys the same territory twice. */
export const SAMPLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SampleAccount {
  name: string;
  domain: string;
  city: string | null;
  state: string | null;
  employees: string | null;
  revenue: string | null;
  industry: string | null;
}

/** The exact paid search for one territory. Its stable key identifies it across runs. */
export interface SampleRequest {
  filter: CompanyFilter;
  pageSize: number;
}

export interface SampleResult {
  accounts: SampleAccount[];
  creditsSpent: number;
}

/** Most a sample can cost before the counts are known: every territory returns a full page. */
export function maxSampleCredits(territories: number, perTerritory: number): number {
  return territories * perTerritory * CREDITS_PER_SAMPLE_ACCOUNT;
}

/**
 * The paid search for one territory, or null when the free count already says it is empty.
 * State ids are sorted so the same territory always produces the same request and key.
 */
export function sampleRequest(
  icp: CompanyFilter,
  country: string,
  stateIds: readonly number[],
  companies: number,
  perTerritory: number,
): SampleRequest | null {
  if (companies === 0 || perTerritory === 0) return null;
  return {
    filter: { ...icp, country, state: [...stateIds].sort((a, b) => a - b) },
    pageSize: Math.min(perTerritory, companies),
  };
}

export function sampleKey(request: SampleRequest): string {
  return stableKey(request);
}

/** Exact cost of the requests still to send: small territories ask for fewer accounts. */
export function estimateSampleCredits(requests: readonly SampleRequest[]): number {
  return requests.reduce((sum, request) => sum + request.pageSize * CREDITS_PER_SAMPLE_ACCOUNT, 0);
}

/** Sends one paid search and returns the accounts with what it cost. */
export async function fetchSampleAccounts(client: CompanyEnrich, request: SampleRequest): Promise<SampleResult> {
  const page = await client.companies.search({ filter: request.filter, pageSize: request.pageSize });
  const accounts = page.items.map((company) => ({
    name: company.name ?? company.domain,
    domain: company.domain,
    city: company.location?.city?.name ?? null,
    state: company.location?.state?.code ?? company.location?.state?.name ?? null,
    employees: company.employees ?? null,
    revenue: company.revenue ?? null,
    industry: company.industry ?? null,
  }));
  return { accounts, creditsSpent: Math.max(1, accounts.length) * CREDITS_PER_SAMPLE_ACCOUNT };
}
