/**
 * Shared setup for the live smoke scripts: the real apps-script/ files, real
 * HTTP, the API key from the environment, and document properties saved to a
 * temp file so the persistent cache survives between runs like it does in a
 * spreadsheet. CacheService starts empty on every run, as if 6 hours had passed.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProperties, type FakeSpreadsheet } from '../harness/fakes.js';
import { createHttpUrlFetchApp, type HttpLogEntry } from '../harness/http-fetch.js';
import { createEnvironment } from '../harness/load.js';

export const STATE_FILE = join(tmpdir(), 'companyenrich-sheets-smoke', 'document-properties.json');

export function startLiveRun(options: { spreadsheet?: FakeSpreadsheet } = {}) {
  const apiKey = process.env.COMPANYENRICH_API_KEY?.trim();
  if (!apiKey) {
    console.error('Set COMPANYENRICH_API_KEY first. Get a key at https://companyenrich.com/dashboard');
    process.exit(1);
  }
  if (process.argv.includes('--reset')) rmSync(STATE_FILE, { force: true });
  const saved = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, string>) : {};
  const documentProperties = new FakeProperties(saved);

  const log: HttpLogEntry[] = [];
  const environment = createEnvironment({
    apiKey,
    documentProperties,
    urlFetch: createHttpUrlFetchApp(log),
    ...options,
  });

  return {
    ...environment,
    log,
    savedCompanies: () => documentProperties.getKeys().filter((key) => key.startsWith('ce:company:')).length,
    /** Writes document properties back to the temp file. */
    save() {
      mkdirSync(join(STATE_FILE, '..'), { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(documentProperties.getProperties(), null, 2));
    },
    /** Remaining credits from the free /v2/me call. Exits with one line if the key is rejected. */
    balance(): number {
      try {
        const me = environment.script.ceMe_();
        return me.credits.total - me.credits.used;
      } catch (error) {
        const rejected = typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
        console.error(
          rejected
            ? 'COMPANYENRICH_API_KEY was rejected (401). Get a key at https://companyenrich.com/dashboard'
            : errorText(error),
        );
        process.exit(1);
      }
    },
  };
}

/** Errors thrown inside the vm context are not `instanceof Error` here, so check the shape. */
export function errorText(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
}

/** Credits that a list of logged responses cost, worked out from the responses themselves. */
export function creditsBilled(entries: HttpLogEntry[]): number {
  let credits = 0;
  for (const entry of entries) {
    if (entry.status !== 200) continue;
    const body = JSON.parse(entry.body);
    if (entry.path === '/v2/companies/enrich') credits += 1;
    if (entry.path === '/v2/companies/enrich/batch') {
      const found = body.items.filter((item: { status: string }) => item.status === 'found');
      credits += new Set(found.map((item: { company: { id: string } }) => item.company.id)).size;
    }
    if (entry.path === '/v2/companies/search') credits += 5 * Math.max(body.items.length, 1);
    if (entry.path === '/v2/people/search') credits += 2 * Math.max(body.items.length, 1);
  }
  return credits;
}

/** "GET /v2/me 200, POST /v2/companies/search/count 200" */
export function describeCalls(entries: HttpLogEntry[]): string {
  return entries.length ? entries.map((entry) => `${entry.method} ${entry.path} ${entry.status}`).join(', ') : 'none';
}

export function formatCredits(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
