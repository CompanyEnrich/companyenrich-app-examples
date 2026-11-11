import type { BatchStatus, CompanyBulkEnrichmentResult, CompanyEnrich } from '@companyenrich/sdk';
import { normalizeDomain } from './domains.js';
import type { EnrichResult } from './types.js';

/** `companies.enrichBatch` accepts at most this many domains per request. */
export const BATCH_LIMIT = 50;

/** One bulk enrichment job accepts at most this many domains. */
export const BULK_LIMIT = 10_000;

export type EnrichPath = 'batch' | 'bulk';

export interface EnrichOutcome {
  path: EnrichPath;
  results: EnrichResult[];
  /**
   * Credits this run spent. For a synchronous batch we count them (1 per unique company found);
   * for a bulk job the API reports `creditsCharged` on the batch status.
   */
  creditsUsed: number;
  batchId?: string;
}

export interface EnrichOptions {
  forceBulk?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onCreated?: (batch: BatchStatus) => void;
  onProgress?: (batch: BatchStatus) => void;
  /**
   * Called as soon as each result arrives, before the next one is read. Saving results here
   * means a run that fails halfway through a bulk download keeps everything already paid for.
   */
  onResult?: (result: EnrichResult) => Promise<void> | void;
}

/** Up to 50 domains fit in one synchronous request; anything larger goes to an async bulk job. */
export function chooseEnrichPath(domainCount: number, forceBulk = false): EnrichPath {
  return forceBulk || domainCount > BATCH_LIMIT ? 'bulk' : 'batch';
}

export async function enrichDomains(
  client: CompanyEnrich,
  domains: string[],
  options: EnrichOptions = {},
): Promise<EnrichOutcome> {
  return chooseEnrichPath(domains.length, options.forceBulk) === 'batch'
    ? enrichWithBatch(client, domains, options)
    : enrichWithBulk(client, domains, options);
}

async function enrichWithBatch(client: CompanyEnrich, domains: string[], options: EnrichOptions): Promise<EnrichOutcome> {
  // A synchronous call should return quickly, so we do not wait for on-demand enrichment.
  // Companies CompanyEnrich has not stored yet come back as `pending`, are enriched in the
  // background, and are picked up by the next run (pending results are free and never cached).
  const { items } = await client.companies.enrichBatch({ domains, waitForEnrichment: false });

  const results = items.map((item): EnrichResult =>
    item.status === 'found' && item.company
      ? { domain: item.domain, status: 'found', company: item.company }
      : { domain: item.domain, status: item.status === 'found' ? 'not-found' : item.status },
  );
  for (const result of results) await options.onResult?.(result);
  // Domains that resolve to the same company are charged once.
  const companyIds = new Set(results.flatMap((result) => (result.company ? [result.company.id] : [])));
  return { path: 'batch', results, creditsUsed: companyIds.size };
}

async function enrichWithBulk(client: CompanyEnrich, domains: string[], options: EnrichOptions): Promise<EnrichOutcome> {
  // The job runs in the background anyway, so each request may wait for on-demand enrichment
  // and the results are complete when the job finishes.
  const batch = await client.companies.bulkEnrichment.create({ domains, waitForEnrichment: true });
  options.onCreated?.(batch);
  return collectBulkResults(client, batch.id, options);
}

/**
 * Waits for a bulk job and streams its records. Also used on its own (`--batch <id>`) to
 * collect a job started by an earlier, interrupted run without paying again.
 */
export async function collectBulkResults(
  client: CompanyEnrich,
  batchId: string,
  options: EnrichOptions = {},
): Promise<EnrichOutcome> {
  const final = await client.batches.waitForCompletion(batchId, {
    pollIntervalMs: options.pollIntervalMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const results: EnrichResult[] = [];
  for await (const record of client.companies.bulkEnrichment.stream(batchId)) {
    const result = fromBulkRecord(record);
    results.push(result);
    await options.onResult?.(result);
  }
  return { path: 'bulk', results, creditsUsed: final.creditsCharged, batchId };
}

function fromBulkRecord(record: CompanyBulkEnrichmentResult): EnrichResult {
  const domain = normalizeDomain(record.domain) ?? record.domain;
  if (record.success && record.company) return { domain, status: 'found', company: record.company };
  if (record.statusCode === 404) return { domain, status: 'not-found' };
  if (record.statusCode === 400 || record.statusCode === 422) return { domain, status: 'invalid-domain' };
  return { domain, status: 'error', message: describeRecordError(record) };
}

function describeRecordError(record: CompanyBulkEnrichmentResult): string {
  const error = record.error as { title?: string; detail?: string } | null | undefined;
  const detail = [error?.title, error?.detail].filter(Boolean).join(': ');
  return detail || `request ${record.state}${record.statusCode ? ` with HTTP ${record.statusCode}` : ''}`;
}
