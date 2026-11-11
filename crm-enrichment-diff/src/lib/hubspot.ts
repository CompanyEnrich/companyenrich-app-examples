import { UserError } from './errors.js';
import type { PatchRow } from './patch.js';
import type { Mapping } from './types.js';

/** HubSpot accepts at most 100 records per batch update request. */
export const HUBSPOT_BATCH_SIZE = 100;
export const HUBSPOT_BATCH_UPDATE_URL = 'https://api.hubapi.com/crm/v3/objects/companies/batch/update';

export interface HubSpotUpdate {
  id: string;
  properties: Record<string, string>;
}

export interface SkippedRow {
  row: PatchRow;
  reason: string;
}

export interface ChunkResult {
  chunk: number;
  ids: string[];
  status: number;
  updated: number;
  errors: string[];
}

/** HubSpot refused the token or the scope; no later request would succeed either. */
export class HubSpotAuthError extends UserError {
  override name = 'HubSpotAuthError';
}

function rowProblem(row: PatchRow): string | null {
  if (row.action === 'skip' || row.action === 'none') return `the action is "${row.action}"`;
  if (!/^\d+$/.test(row.record_id)) return `"${row.record_id}" is not a HubSpot Record ID`;
  if (!row.new_value.trim()) return 'new_value is empty, and this tool never clears a field';
  return null;
}

/**
 * Groups approved patch rows into one HubSpot update per record. Field paths are mapped back to
 * HubSpot property names through the mapping file. Rows that cannot be written safely are
 * returned in `skipped` with a reason instead of being sent.
 */
export function buildHubSpotUpdates(rows: PatchRow[], mapping: Mapping): { updates: HubSpotUpdate[]; skipped: SkippedRow[] } {
  const propertyByField = new Map(
    mapping.fields.flatMap((field) => (field.hubspotProperty ? [[field.path, field.hubspotProperty] as const] : [])),
  );
  const byRecord = new Map<string, Record<string, string>>();
  const skipped: SkippedRow[] = [];

  for (const row of rows) {
    const property = propertyByField.get(row.field);
    if (!property) {
      skipped.push({ row, reason: `the mapping has no hubspotProperty for "${row.field}"` });
      continue;
    }
    const reason = rowProblem(row);
    if (reason) {
      skipped.push({ row, reason });
      continue;
    }
    const properties = byRecord.get(row.record_id) ?? {};
    properties[property] = row.new_value;
    byRecord.set(row.record_id, properties);
  }

  return { updates: [...byRecord].map(([id, properties]) => ({ id, properties })), skipped };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

export interface SendOptions {
  token: string;
  fetch?: typeof fetch;
  url?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onChunk?: (result: ChunkResult) => void;
}

interface HubSpotBody {
  message?: string;
  results?: unknown[];
  errors?: { message?: string; context?: { ids?: string[] } }[];
}

/** Sends batch updates in chunks of 100. A 429 is retried after HubSpot's Retry-After delay. */
export async function sendHubSpotUpdates(updates: HubSpotUpdate[], options: SendOptions): Promise<ChunkResult[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 3;
  const results: ChunkResult[] = [];

  for (const [index, inputs] of chunk(updates, HUBSPOT_BATCH_SIZE).entries()) {
    const ids = inputs.map((input) => input.id);
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetchImpl(options.url ?? HUBSPOT_BATCH_UPDATE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
      if (response.status !== 429 || attempt >= maxRetries) break;
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 10_000);
    }

    const body = (await response.json().catch(() => ({}))) as HubSpotBody;
    if (response.status === 401 || response.status === 403) {
      throw new HubSpotAuthError(
        `HubSpot rejected the token (HTTP ${response.status}): ${body.message ?? 'check HUBSPOT_TOKEN and the crm.objects.companies.write scope'}`,
      );
    }

    const ok = response.status === 200 || response.status === 207;
    const errors = ok
      ? (body.errors ?? []).map((error) => `${error.context?.ids?.join(', ') ?? 'batch'}: ${error.message ?? 'unknown error'}`)
      : [body.message ?? `HTTP ${response.status}`];
    const result: ChunkResult = { chunk: index + 1, ids, status: response.status, updated: ok ? (body.results?.length ?? 0) : 0, errors };
    results.push(result);
    options.onChunk?.(result);
  }
  return results;
}
