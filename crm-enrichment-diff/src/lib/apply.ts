import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMapping, readText } from './config.js';
import { UserError } from './errors.js';
import {
  buildHubSpotUpdates,
  chunk,
  HUBSPOT_BATCH_SIZE,
  sendHubSpotUpdates,
  type ChunkResult,
  type HubSpotUpdate,
  type SkippedRow,
} from './hubspot.js';
import { parsePatchCsv } from './patch.js';
import { formatRunId } from './report.js';

export interface ApplyOptions {
  patchPath: string;
  mappingPath: string;
  /** Without this, apply only prints what it would send. */
  execute: boolean;
  outDir: string;
}

export interface ApplyDeps {
  token: string | undefined;
  log: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type ApplyResult =
  | { kind: 'preview'; updates: HubSpotUpdate[]; skipped: SkippedRow[] }
  | { kind: 'sent'; updates: HubSpotUpdate[]; skipped: SkippedRow[]; chunks: ChunkResult[]; logFile: string };

const shorten = (value: string, max = 48): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export async function runApply(options: ApplyOptions, deps: ApplyDeps): Promise<ApplyResult> {
  const { log } = deps;
  const mapping = await loadMapping(options.mappingPath);
  const rows = parsePatchCsv(await readText(options.patchPath), options.patchPath);
  const { updates, skipped } = buildHubSpotUpdates(rows, mapping);
  const values = updates.reduce((sum, update) => sum + Object.keys(update.properties).length, 0);
  const requests = chunk(updates, HUBSPOT_BATCH_SIZE).length;

  log(`Read ${rows.length} changes from ${options.patchPath}.`);
  log(`HubSpot: ${values} property values on ${updates.length} companies, in ${requests} batch update request(s) of up to ${HUBSPOT_BATCH_SIZE}.`);
  for (const update of updates.slice(0, 5)) {
    const properties = Object.entries(update.properties).map(([name, value]) => `${name}=${shorten(value)}`);
    log(`  ${update.id}: ${properties.join(', ')}`);
  }
  if (updates.length > 5) log(`  ...and ${updates.length - 5} more companies`);
  for (const { row, reason } of skipped) log(`  skipped ${row.record_id} ${row.field}: ${reason}`);

  if (!options.execute) {
    log('Preview only: nothing was sent to HubSpot. Add --execute to write these values.');
    return { kind: 'preview', updates, skipped };
  }
  if (!deps.token) {
    throw new UserError('Set HUBSPOT_TOKEN to a HubSpot private app token with the crm.objects.companies.write scope.');
  }

  const chunks = await sendHubSpotUpdates(updates, {
    token: deps.token,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onChunk: (result) => {
      log(`  request ${result.chunk}/${requests}: HTTP ${result.status}, ${result.updated} updated`);
      for (const error of result.errors) log(`    error: ${error}`);
    },
  });

  const now = deps.now ?? (() => new Date());
  const logFile = join(options.outDir, `apply-${formatRunId(now())}.json`);
  await mkdir(options.outDir, { recursive: true });
  await writeFile(logFile, JSON.stringify({ patch: options.patchPath, updates, skipped, chunks }, null, 2) + '\n');

  const updated = chunks.reduce((sum, result) => sum + result.updated, 0);
  const failed = chunks.filter((result) => result.errors.length > 0).length;
  log(`Done: ${updated} of ${updates.length} companies updated${failed ? `, ${failed} request(s) with errors` : ''}. Log: ${logFile}`);
  return { kind: 'sent', updates, skipped, chunks, logFile };
}
