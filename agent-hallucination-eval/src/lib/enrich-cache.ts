import type { Company, CompanyEnrichStatus } from '@companyenrich/sdk';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeDomain } from './domains.ts';
import { readJsonl } from './jsonl.ts';

/** The saved outcome of enriching one domain. */
export interface EnrichEntry {
  /** The domain as requested, normalized. This is the cache key. */
  domain: string;
  status: CompanyEnrichStatus;
  company?: Company;
  /** The day the record was fetched (YYYY-MM-DD), used as the questions' retrieval date. */
  fetchedAt: string;
}

/** Paid results live next to the question set: `data/eval-2026-11-11.jsonl` -> `data/eval-2026-11-11.enrich.jsonl`. */
export function enrichCachePath(questionsPath: string): string {
  return questionsPath.replace(/\.jsonl$/, '') + '.enrich.jsonl';
}

/**
 * Reads saved results, keyed by domain. An entry is used only when its key is a normalized
 * domain and a `found` entry really carries a company, so a hand-edited or stale line is ignored
 * rather than answering for the wrong company.
 */
export async function readEnrichCache(path: string): Promise<Map<string, EnrichEntry>> {
  const entries = existsSync(path) ? await readJsonl<EnrichEntry>(path) : [];
  const valid = entries.filter(
    (entry) =>
      typeof entry.domain === 'string' &&
      normalizeDomain(entry.domain) === entry.domain &&
      (entry.status !== 'found' || typeof entry.company?.domain === 'string'),
  );
  return new Map(valid.map((entry) => [entry.domain, entry]));
}

export async function appendEnrichCache(path: string, entries: EnrichEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, entries.map((entry) => JSON.stringify(entry) + '\n').join(''));
}
