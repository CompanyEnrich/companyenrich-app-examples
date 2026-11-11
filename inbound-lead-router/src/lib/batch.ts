import type { CompanyExpansion } from '@companyenrich/sdk';
import type { ApiCall } from './client';
import { toCompanyFacts } from './company';
import { enrichCost } from './credits';
import { domainFromInput, freeMailMatch } from './email';
import { usableCacheEntry, type CompanyCache, type CompanyLookup } from './enrich';
import { certainlyNotBilled, describeApiError } from './errors';

// Batch enrichment for the rules playground and the CSV scorer. Planning is
// free and offline: it sorts inputs into invalid, free-mail, cached and
// to-enrich, and prices the paid part. Running it calls `enrichBatch`.

export const BATCH_SIZE = 50;

export type PlannedStatus = 'invalid' | 'free-mail' | 'cached' | 'enrich' | 'over-budget';

export interface PlannedItem {
  input: string;
  domain: string | null;
  status: PlannedStatus;
  /** The cached answer, for `cached` items. */
  cached?: CompanyLookup;
}

export interface BatchPlan {
  items: PlannedItem[];
  expand: CompanyExpansion[];
  creditsPerCompany: number;
  /** Unique domains that need a paid lookup, in input order. */
  toEnrich: string[];
  /** Upper bound for the paid part. Domains that are not found cost nothing. */
  maxCredits: number;
}

/** Sorts inputs and prices the run. With `budget`, domains beyond it are marked `over-budget`. */
export function planBatch(inputs: readonly string[], cache: CompanyCache, expand: CompanyExpansion[], budget?: number): BatchPlan {
  const creditsPerCompany = enrichCost(expand);
  const affordable = budget === undefined ? Infinity : Math.floor(budget / creditsPerCompany);
  const toEnrich: string[] = [];

  const items = inputs.map((input): PlannedItem => {
    const domain = domainFromInput(input);
    if (!domain) return { input, domain: null, status: 'invalid' };
    if (freeMailMatch(domain)) return { input, domain, status: 'free-mail' };
    const cached = usableCacheEntry(cache, domain, expand);
    if (cached) return { input, domain, status: 'cached', cached: cached.value };
    if (toEnrich.includes(domain)) return { input, domain, status: 'enrich' };
    if (toEnrich.length >= affordable) return { input, domain, status: 'over-budget' };
    toEnrich.push(domain);
    return { input, domain, status: 'enrich' };
  });

  return { items, expand, creditsPerCompany, toEnrich, maxCredits: toEnrich.length * creditsPerCompany };
}

/** `pending`: the API is still enriching the company in the background; try again later. */
export type BatchLookup = CompanyLookup | { status: 'pending' } | { status: 'error'; message: string };

export interface BatchRun {
  lookups: Map<string, BatchLookup>;
  credits: number;
  /** Worst case for chunks that failed in a way that may still have been billed (5xx, timeout). */
  uncertainCredits: number;
  /** Set when a request failed; later chunks are not sent. */
  error: string | null;
}

/** Sends the plan's domains in chunks of 50. Chunks run behind the shared limiter, so `call` sets the concurrency. */
export async function runBatch(call: ApiCall, cache: CompanyCache, plan: BatchPlan): Promise<BatchRun> {
  const lookups = new Map<string, BatchLookup>();
  const chargedCompanies = new Set<string>();
  let uncertainCredits = 0;
  let error: string | null = null;

  const chunks: string[][] = [];
  for (let i = 0; i < plan.toEnrich.length; i += BATCH_SIZE) chunks.push(plan.toEnrich.slice(i, i + BATCH_SIZE));

  await Promise.all(
    chunks.map(async (domains) => {
      try {
        // Checked when the chunk gets its turn, so nothing more is sent after a failure.
        const response = await call((client) => (error ? Promise.resolve(null) : client.companies.enrichBatch({ domains, expand: plan.expand })));
        if (!response) {
          for (const domain of domains) lookups.set(domain, { status: 'error', message: 'Not sent after an earlier error' });
          return;
        }
        for (const item of response.items) {
          if (item.status === 'pending') {
            lookups.set(item.domain, { status: 'pending' });
            continue;
          }
          const lookup: CompanyLookup =
            item.status === 'found' && item.company
              ? { status: 'found', company: toCompanyFacts(item.company, plan.expand), expand: plan.expand }
              : { status: item.status === 'invalid-domain' ? 'invalid-domain' : 'not-found' };
          // Domains that resolve to the same company are billed once.
          if (lookup.status === 'found') chargedCompanies.add(lookup.company.id);
          lookups.set(item.domain, lookup);
          cache.set(item.domain, lookup);
        }
      } catch (caught) {
        const message = describeApiError(caught);
        if (!message) throw caught;
        error ??= message;
        if (!certainlyNotBilled(caught)) uncertainCredits += domains.length * plan.creditsPerCompany;
        for (const domain of domains) lookups.set(domain, { status: 'error', message });
      }
    }),
  );

  return { lookups, credits: chargedCompanies.size * plan.creditsPerCompany, uncertainCredits, error };
}

/** The final answer for one planned item after a run. */
export function itemLookup(item: PlannedItem, run: BatchRun | null): BatchLookup | null {
  if (item.cached) return item.cached;
  if (item.status !== 'enrich' || !item.domain) return null;
  return run?.lookups.get(item.domain) ?? null;
}
