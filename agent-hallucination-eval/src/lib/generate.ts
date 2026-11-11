import type { Company, CompanyEnrich } from '@companyenrich/sdk';
import { mapWithConcurrency } from './concurrency.ts';
import { appendEnrichCache, readEnrichCache, type EnrichEntry } from './enrich-cache.ts';
import { buildQuestions, fundingStageOptions, topLevelIndustries } from './questions.ts';
import type { Question } from './types.ts';

/** 1 credit for the enrichment plus 1 for the `financial` expansion, charged only when a company is found. */
export const CREDITS_PER_COMPANY = 2;
const BATCH_SIZE = 50;

/** Running total of credits spent, readable even after a failure. */
export interface Ledger {
  creditsSpent: number;
}

/** The domains that still need a paid lookup: everything not already saved in the cache. */
export async function uncachedDomains(domains: string[], cachePath: string): Promise<string[]> {
  const cache = await readEnrichCache(cachePath);
  return domains.filter((domain) => !cache.has(domain));
}

/**
 * Enriches domains with funding data, 50 per `enrichBatch` call, and returns one entry per domain.
 *
 * Domains already in the cache are not bought again. Each finished batch is appended to the cache and
 * added to `ledger` before the next request, so a failure later never loses paid results and running
 * again resumes where it stopped. `pending` results are not saved, so they are asked for again next time.
 */
export async function enrichWithCache(
  client: CompanyEnrich,
  domains: string[],
  cachePath: string,
  fetchedAt: string,
  ledger: Ledger,
): Promise<EnrichEntry[]> {
  const cache = await readEnrichCache(cachePath);
  const todo = domains.filter((domain) => !cache.has(domain));

  for (let start = 0; start < todo.length; start += BATCH_SIZE) {
    const chunk = todo.slice(start, start + BATCH_SIZE);
    const { items } = await client.companies.enrichBatch({ domains: chunk, expand: ['financial'] });

    // Items come back in request order, so the requested domain is the key.
    const entries: EnrichEntry[] = items.map((item, i) => ({
      domain: chunk[i]!,
      status: item.status,
      ...(item.company ? { company: item.company } : {}),
      fetchedAt,
    }));
    // A batch charges each company once, even when several of its domains resolve to it.
    const companiesCharged = new Set(entries.flatMap((entry) => (entry.company ? [entry.company.id] : []))).size;

    const settled = entries.filter((entry) => entry.status !== 'pending');
    await appendEnrichCache(cachePath, settled);
    for (const entry of settled) cache.set(entry.domain, entry);
    ledger.creditsSpent += companiesCharged * CREDITS_PER_COMPANY;
  }

  return domains.map((domain) => cache.get(domain) ?? { domain, status: 'pending', fetchedAt });
}

/** Builds the question set. The industry list comes from the free `industries.list()` endpoint. */
export async function buildEvalSet(client: CompanyEnrich, entries: EnrichEntry[]): Promise<Question[]> {
  // Two domains can resolve to one company; ask about it once.
  const found = new Map<string, { company: Company; fetchedAt: string }>();
  for (const entry of entries) {
    if (entry.company && !found.has(entry.company.id)) found.set(entry.company.id, { company: entry.company, fetchedAt: entry.fetchedAt });
  }
  const companies = [...found.values()].map((f) => f.company);

  const { items } = await client.industries.list();
  const observed = companies.map((c) => c.industry).filter((name): name is string => !!name);
  const industries = topLevelIndustries([...items.map((industry) => industry.name), ...observed]);
  const fundingStages = fundingStageOptions(companies);

  return [...found.values()].flatMap(({ company, fetchedAt }) =>
    buildQuestions(company, { retrievedAt: fetchedAt, industries, fundingStages }),
  );
}

export interface GeneratePlan {
  domains: string[];
  estimatedCredits: number;
  /** Domains the free autocomplete endpoint does not know. They will likely come back not-found and cost nothing. */
  unknownDomains: string[];
  creditsRemaining: number;
}

/** The free dry run: checks each domain with autocomplete and reads the balance. Spends 0 credits. */
export async function planGenerate(client: CompanyEnrich, domains: string[]): Promise<GeneratePlan> {
  const known = await mapWithConcurrency(domains, 4, async (domain) => {
    const { items } = await client.companies.autocomplete(domain);
    return items.some((item) => item.domain === domain);
  });
  const me = await client.me();
  return {
    domains,
    estimatedCredits: domains.length * CREDITS_PER_COMPANY,
    unknownDomains: domains.filter((_, i) => !known[i]),
    creditsRemaining: me.credits.total - me.credits.used,
  };
}
