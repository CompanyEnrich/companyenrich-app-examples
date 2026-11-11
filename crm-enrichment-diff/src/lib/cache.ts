import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UserError } from './errors.js';
import type { EnrichResult, EnrichStatus } from './types.js';

export interface CacheEntry extends EnrichResult {
  fetchedAt: string;
}

/** Only final answers are cached. `pending` and `error` results are retried on the next run. */
const FINAL_STATUSES: EnrichStatus[] = ['found', 'not-found', 'invalid-domain'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a parsed cache file before trusting it. A file that was renamed, copied, edited or
 * truncated must never stand in for another domain's lookup.
 */
function isEntryFor(entry: unknown, domain: string): entry is CacheEntry {
  if (!isObject(entry) || entry.domain !== domain) return false;
  if (!FINAL_STATUSES.includes(entry.status as EnrichStatus)) return false;
  return entry.status !== 'found' || (isObject(entry.company) && typeof entry.company.id === 'string');
}

/**
 * One JSON file per domain, so a re-run never pays twice for the same company and the
 * cached data is easy to inspect. Delete the folder to fetch fresh data.
 */
export class DomainCache {
  constructor(readonly dir: string) {}

  private file(domain: string): string {
    // Domains are already normalized to [a-z0-9.-], so they are safe file names.
    return join(this.dir, `${domain}.json`);
  }

  /** Fails before any paid call if results could not be saved afterwards. */
  async ensureWritable(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await access(this.dir, constants.W_OK);
    } catch {
      throw new UserError(`Cannot write to the cache folder ${this.dir}. Choose another --out folder.`);
    }
  }

  async get(domain: string): Promise<CacheEntry | undefined> {
    let entry: unknown;
    try {
      entry = JSON.parse(await readFile(this.file(domain), 'utf8'));
    } catch {
      return undefined;
    }
    return isEntryFor(entry, domain) ? entry : undefined;
  }

  async set(result: EnrichResult, now = new Date()): Promise<void> {
    if (!FINAL_STATUSES.includes(result.status)) return;
    await mkdir(this.dir, { recursive: true });
    const entry: CacheEntry = { ...result, fetchedAt: now.toISOString() };
    await writeFile(this.file(result.domain), JSON.stringify(entry, null, 2) + '\n');
  }
}
