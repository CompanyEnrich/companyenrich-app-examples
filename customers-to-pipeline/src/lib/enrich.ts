import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CompanyExpansion } from '@companyenrich/sdk';
import { COST } from './credits.js';
import type { Company, CompanyEnrich } from './types.js';

const BATCH_SIZE = 50; // the enrichBatch maximum

interface CacheEntry {
  domain: string;
  expand: CompanyExpansion[];
  fetchedAt: string;
  company: Company;
}

function isEntryFor(entry: unknown, domain: string): entry is CacheEntry {
  const candidate = entry as Partial<CacheEntry> | null;
  return (
    candidate?.domain === domain &&
    Array.isArray(candidate.expand) &&
    typeof candidate.company?.id === 'string' &&
    typeof candidate.company.domain === 'string'
  );
}

/** One JSON file per domain, so a re-run never pays twice for the same customer. */
export class CompanyCache {
  constructor(private readonly dir: string) {}

  /**
   * Returns the cached company if the file was written for this exact lookup domain and fetched with at
   * least the requested expansions. A renamed, stale or malformed file is treated as a cache miss.
   * The company's own domain may differ (acme.io can resolve to acme.com), so it is not compared.
   */
  async get(domain: string, expand: readonly CompanyExpansion[]): Promise<Company | undefined> {
    let entry: unknown;
    try {
      entry = JSON.parse(await readFile(this.file(domain), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (!isEntryFor(entry, domain)) return undefined;
    return expand.every((name) => entry.expand.includes(name)) ? entry.company : undefined;
  }

  async set(domain: string, expand: readonly CompanyExpansion[], company: Company): Promise<void> {
    const entry: CacheEntry = { domain, expand: [...expand], fetchedAt: new Date().toISOString(), company };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(domain), JSON.stringify(entry, null, 2));
  }

  // Domains are validated by normalizeDomain, so they are safe to use as file names.
  private file(domain: string): string {
    return path.join(this.dir, `${domain}.json`);
  }
}

export async function loadCached(
  domains: readonly string[],
  expand: readonly CompanyExpansion[],
  cache: CompanyCache,
): Promise<Map<string, Company>> {
  const found = new Map<string, Company>();
  for (const domain of domains) {
    const company = await cache.get(domain, expand);
    if (company) found.set(domain, company);
  }
  return found;
}

export interface EnrichmentResult {
  /** Found companies keyed by the customer domain that was sent. */
  companies: Map<string, Company>;
  notFound: string[];
  /** Domains the API is still enriching in the background; a later run will pick them up. */
  pending: string[];
  invalid: string[];
  credits: number;
}

/**
 * Enriches domains in batches of 50 and caches every company found. `onBatch` hears about each
 * batch's charge as soon as it is billed, so a failure in a later batch never hides earlier spend.
 */
export async function enrichMissing(
  client: CompanyEnrich,
  domains: readonly string[],
  expand: readonly CompanyExpansion[],
  cache: CompanyCache,
  onBatch: (domains: number, credits: number) => void = () => {},
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = { companies: new Map(), notFound: [], pending: [], invalid: [], credits: 0 };

  for (let start = 0; start < domains.length; start += BATCH_SIZE) {
    const batch = domains.slice(start, start + BATCH_SIZE);
    const { items } = await client.companies.enrichBatch({
      domains: batch,
      ...(expand.length > 0 ? { expand: [...expand] } : {}),
    });

    // Billing is per unique company, so two domains that resolve to one company cost one credit.
    const billedIds = new Set<string>();
    for (const item of items) {
      if (item.status === 'found' && item.company) {
        result.companies.set(item.domain, item.company);
        billedIds.add(item.company.id);
        await cache.set(item.domain, expand, item.company);
      } else if (item.status === 'pending') {
        result.pending.push(item.domain);
      } else if (item.status === 'invalid-domain') {
        result.invalid.push(item.domain);
      } else {
        result.notFound.push(item.domain);
      }
    }
    const credits = billedIds.size * (COST.enrich + expand.length * COST.expansion);
    result.credits += credits;
    onBatch(batch.length, credits);
  }
  return result;
}
