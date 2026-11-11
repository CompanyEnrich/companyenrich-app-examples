import { join, resolve } from 'node:path';
import { TtlCache } from './cache';
import { COMPANY_CACHE_TTL_MS, type CompanyCache } from './enrich';

/** Where runtime state lives: the enrichment cache and round-robin assignments. */
export function stateDir(): string {
  const custom = process.env.STATE_DIR?.trim();
  // The comment stops Next.js from tracing the whole project for this runtime path.
  return custom ? resolve(/* turbopackIgnore: true */ custom) : join(process.cwd(), 'state');
}

/** The 24-hour company cache, shared on disk by the web app and the batch CLI. */
export function openCompanyCache(): CompanyCache {
  return new TtlCache({ ttlMs: COMPANY_CACHE_TTL_MS, file: join(stateDir(), 'company-cache.json') });
}
