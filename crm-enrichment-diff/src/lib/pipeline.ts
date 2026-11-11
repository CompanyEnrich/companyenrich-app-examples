import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchStatus, CompanyEnrich } from '@companyenrich/sdk';
import { DomainCache } from './cache.js';
import { loadMapping, loadRules, readText } from './config.js';
import { diffRecord } from './diff.js';
import {
  BULK_LIMIT,
  chooseEnrichPath,
  collectBulkResults,
  enrichDomains,
  type EnrichOptions,
  type EnrichPath,
} from './enrich.js';
import { describeError, UserError } from './errors.js';
import { readCrmExport, type CrmExport } from './input.js';
import { renderPatchCsv } from './patch.js';
import { countCells, formatRunId, renderSummary, type FailedRun, type RunReport } from './report.js';
import { renderReviewHtml } from './review-html.js';
import { applyRules } from './rules.js';
import type { DiffCell, EnrichResult, Mapping, RecordSummary, Rules } from './types.js';

export interface DiffOptions {
  csvPath: string;
  mappingPath: string;
  rulesPath: string;
  outDir: string;
  maxCredits: number;
  dryRun: boolean;
  forceBulk: boolean;
  /** Collect an existing bulk job into the cache before diffing. */
  batchId?: string;
  pollIntervalMs?: number;
}

export interface DiffDeps {
  /** Builds the SDK client. Called only when the run needs the API. */
  createClient: () => CompanyEnrich;
  /** Whether an API key is configured. A dry run without one still prints the plan. */
  hasApiKey: boolean;
  log: (line: string) => void;
  now?: () => Date;
}

export interface Plan {
  rows: number;
  domains: number;
  cached: number;
  toEnrich: string[];
  path: EnrichPath | 'cache-only';
  /** Upper bound: 1 credit per company found, and not-found domains are free. */
  estimatedCredits: number;
}

export type DiffResult =
  | { kind: 'dry-run'; plan: Plan; balance?: number }
  | { kind: 'done'; plan: Plan; report: RunReport; runDir: string; cells: DiffCell[] };

export class CreditCapError extends UserError {
  override name = 'CreditCapError';
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Credits left on the account, from the free `me()` call. */
async function balance(client: CompanyEnrich): Promise<number> {
  const { credits } = await client.me();
  return credits.total - credits.used;
}

function progressLogger(log: (line: string) => void): (batch: BatchStatus) => void {
  let last = '';
  return ({ progress, status }) => {
    const done = progress.succeeded + progress.failed + progress.unknown + progress.cancelled;
    const line = `  bulk job ${status}: ${done}/${progress.total} done`;
    if (line !== last) log(line);
    last = line;
  };
}

const shellArg = (value: string): string => (/^[\w./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The command that collects a bulk job into the cache, with the same files and output folder. */
export function resumeCommand(options: DiffOptions, batchId: string): string {
  const args = ['diff', options.csvPath, '--batch', batchId];
  args.push('--mapping', options.mappingPath, '--rules', options.rulesPath, '--out', options.outDir);
  return `npm start -- ${args.map(shellArg).join(' ')}`;
}

function describeInput(crm: CrmExport, csvPath: string): string {
  const withoutDomain = crm.records.filter((record) => !record.domain).length;
  return (
    `Read ${plural(crm.records.length, 'row')} from ${csvPath}: ${plural(crm.domains.length, 'unique domain')}` +
    (crm.duplicates.size > 0 ? `, ${plural(crm.duplicates.size, 'domain')} shared by several records` : '') +
    (withoutDomain > 0 ? `, ${plural(withoutDomain, 'row')} without a usable domain` : '')
  );
}

function describePlan(plan: Plan, maxCredits: number): string {
  if (plan.path === 'cache-only') return 'Nothing to enrich: every domain is cached. Estimated cost: 0 credits.';
  const method = plan.path === 'batch' ? 'companies.enrichBatch (one request)' : 'companies.bulkEnrichment (async job)';
  return (
    `Plan: enrich ${plan.toEnrich.length} domains with ${method}. ` +
    `Estimated cost: up to ${plan.estimatedCredits} credits (1 per company found, misses are free). Cap: ${maxCredits}.`
  );
}

/** Compares every enriched record with its company and lets the rules decide each cell. */
function diffAll(crm: CrmExport, results: Map<string, EnrichResult>, mapping: Mapping, rules: Rules) {
  const cells: DiffCell[] = [];
  const records: RecordSummary[] = [];
  for (const record of crm.records) {
    const result = record.domain ? results.get(record.domain) : undefined;
    const sharing = record.domain ? (crm.duplicates.get(record.domain) ?? []) : [];
    records.push({
      recordId: record.recordId,
      company: record.name || result?.company?.name || '',
      domain: record.domain ?? record.rawDomain,
      status: !record.domain ? 'no-domain' : (result?.status ?? 'not-enriched'),
      duplicateOf: sharing.filter((id) => id !== record.recordId),
      ...(result?.message ? { message: result.message } : {}),
    });
    if (result?.company) cells.push(...applyRules(diffRecord(record, result.company, mapping.fields), rules));
  }
  return { cells, records };
}

async function writeOutputs(runDir: string, report: RunReport, cells: DiffCell[], columns: string[]): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const review = renderReviewHtml({
    runId: report.runId,
    generatedAt: report.finishedAt,
    input: report.input,
    columns,
    cells,
    records: report.records,
  });
  await writeFile(join(runDir, 'review.html'), review);
  await writeFile(join(runDir, 'patch.csv'), renderPatchCsv(cells));
  await writeFile(join(runDir, 'summary.md'), renderSummary(report));
  await writeFile(join(runDir, 'run.json'), JSON.stringify(report, null, 2) + '\n');
}

interface Failure {
  options: DiffOptions;
  /** `enrich` buys results; `collect` only downloads a bulk job's results, which is free. */
  stage: 'enrich' | 'collect';
  path: Plan['path'];
  credits: RunReport['credits'];
  batchId: string | undefined;
  /** Results received and cached before the failure. */
  fresh: EnrichResult[];
  error: unknown;
  startedAt: Date;
  now: () => Date;
  client: CompanyEnrich;
  log: (line: string) => void;
}

/**
 * Records a run that stopped after it may have spent credits: writes a failed ledger, says what
 * was kept and how to resume, and returns the error to throw.
 */
async function fail(failure: Failure): Promise<UserError> {
  const { options, batchId, fresh, error, log } = failure;
  let used = new Set(fresh.flatMap((result) => (result.company ? [result.company.id] : []))).size;
  let note = 'Counted from the results received before the failure (1 credit per company found).';
  if (batchId) {
    let charged: number | undefined;
    try {
      // Free status call: the job's own count of credits charged so far.
      charged = (await failure.client.batches.get(batchId)).creditsCharged;
    } catch {
      note = `Bulk job ${batchId} status was unreachable; this counts only the results received.`;
    }
    if (failure.stage === 'collect') {
      used = 0;
      note = `This run only downloaded results of bulk job ${batchId}, which is free.` +
        (charged === undefined ? '' : ` The job has charged ${charged} credits since it started.`);
    } else if (charged !== undefined) {
      used = charged;
      note = `Charged so far by bulk job ${batchId}. The job keeps running and charges for the rest as it finishes.`;
    }
  }

  const runId = formatRunId(failure.startedAt);
  const ledger: FailedRun = {
    runId,
    status: 'failed',
    startedAt: failure.startedAt.toISOString(),
    failedAt: failure.now().toISOString(),
    input: options.csvPath,
    error: describeError(error) ?? String(error),
    enrichment: { path: failure.path, ...(batchId ? { batchId } : {}), resultsCached: fresh.length },
    credits: {
      cap: failure.credits.cap,
      estimated: failure.credits.estimated,
      used,
      note,
      ...(failure.credits.balanceBefore === undefined ? {} : { balanceBefore: failure.credits.balanceBefore }),
    },
    ...(batchId ? { resumeCommand: resumeCommand(options, batchId) } : {}),
  };
  const file = join(options.outDir, runId, 'run.json');
  await mkdir(join(options.outDir, runId), { recursive: true });
  await writeFile(file, JSON.stringify(ledger, null, 2) + '\n');

  log(`Stopped. ${fresh.length} results were cached and will not be bought again. Ledger: ${file}`);
  if (batchId) log(`The bulk job keeps its results on the server. Collect them without paying again:\n    ${resumeCommand(options, batchId)}`);
  const action = failure.stage === 'collect' ? 'Collecting the bulk job' : 'Enrichment';
  return new UserError(`${action} failed: ${describeError(error) ?? (error as Error).message}`, { cause: error });
}

export async function runDiff(options: DiffOptions, deps: DiffDeps): Promise<DiffResult> {
  const { log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  // 1. Read the export and normalize and deduplicate its domains.
  const mapping = await loadMapping(options.mappingPath);
  const rules = await loadRules(options.rulesPath, mapping);
  const crm = readCrmExport(await readText(options.csvPath), mapping);
  log(describeInput(crm, options.csvPath));
  const cache = new DomainCache(join(options.outDir, '.cache'));
  if (!options.dryRun) await cache.ensureWritable();

  let client: CompanyEnrich | undefined;
  const api = (): CompanyEnrich => (client ??= deps.createClient());
  const bulkOptions: EnrichOptions = {
    onProgress: progressLogger(log),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  };

  // 2. Optionally collect a bulk job from an earlier, interrupted run. Downloading results is free.
  let importedBatch: RunReport['enrichment']['importedBatch'];
  if (options.batchId && options.dryRun) log(`Dry run: not collecting bulk job ${options.batchId}.`);
  if (options.batchId && !options.dryRun) {
    const batchId = options.batchId;
    log(`Collecting bulk job ${batchId} into the cache (downloading results is free)...`);
    const collected: EnrichResult[] = [];
    try {
      const imported = await collectBulkResults(api(), batchId, {
        ...bulkOptions,
        onResult: async (result) => {
          collected.push(result);
          await cache.set(result);
        },
      });
      importedBatch = { id: batchId, records: collected.length, creditsCharged: imported.creditsUsed };
      log(`  ${collected.length} records collected; the job charged ${imported.creditsUsed} credits when it ran.`);
    } catch (error) {
      const credits = { cap: options.maxCredits, estimated: 0, used: 0 };
      throw await fail({ options, stage: 'collect', path: 'bulk', credits, batchId, fresh: collected, error, startedAt, now, client: api(), log });
    }
  }

  // 3. Plan: only domains missing from the cache cost anything.
  const results = new Map<string, EnrichResult>();
  for (const domain of crm.domains) {
    const cached = await cache.get(domain);
    if (cached) results.set(domain, cached);
  }
  const toEnrich = crm.domains.filter((domain) => !results.has(domain));
  const plan: Plan = {
    rows: crm.records.length,
    domains: crm.domains.length,
    cached: results.size,
    toEnrich,
    path: toEnrich.length > 0 ? chooseEnrichPath(toEnrich.length, options.forceBulk) : 'cache-only',
    estimatedCredits: toEnrich.length,
  };
  log(`Cache: ${plan.cached} of ${plan.domains} domains already enriched in ${cache.dir}`);
  log(describePlan(plan, options.maxCredits));

  if (options.dryRun) {
    const credits = deps.hasApiKey ? await balance(api()) : undefined;
    log(credits === undefined ? 'Set COMPANYENRICH_API_KEY to also check your balance.' : `Balance: ${credits} credits (checked with the free me() call).`);
    log('Dry run: no paid calls were made and no files were written.');
    return { kind: 'dry-run', plan, ...(credits === undefined ? {} : { balance: credits }) };
  }
  if (toEnrich.length > BULK_LIMIT) {
    throw new UserError(`${toEnrich.length} domains need enrichment; one bulk job takes at most ${BULK_LIMIT}. Split the CSV.`);
  }
  if (plan.estimatedCredits > options.maxCredits) {
    throw new CreditCapError(
      `This run could spend up to ${plan.estimatedCredits} credits, above --max-credits ${options.maxCredits}. ` +
        'Raise --max-credits or split the CSV. Nothing was spent.',
    );
  }

  // 4. Enrich what is missing, with one batch request or a bulk job. Each result is cached the
  //    moment it arrives, so a run that fails halfway keeps everything already paid for.
  const credits: RunReport['credits'] = { cap: options.maxCredits, estimated: plan.estimatedCredits, used: 0 };
  let batchId: string | undefined;
  if (toEnrich.length > 0) {
    credits.balanceBefore = await balance(api());
    const fresh: EnrichResult[] = [];
    try {
      const outcome = await enrichDomains(api(), toEnrich, {
        ...bulkOptions,
        forceBulk: options.forceBulk,
        onCreated: (batch) => {
          batchId = batch.id;
          log(`  bulk job ${batch.id} started. If this run is interrupted, collect it without paying again:`);
          log(`    ${resumeCommand(options, batch.id)}`);
        },
        onResult: async (result) => {
          fresh.push(result);
          results.set(result.domain, result);
          await cache.set(result);
        },
      });
      credits.used = outcome.creditsUsed;
    } catch (error) {
      throw await fail({ options, stage: 'enrich', path: plan.path, credits, batchId, fresh, error, startedAt, now, client: api(), log });
    }
    credits.balanceAfter = await balance(api());
    log(`Enriched ${fresh.length} domains. Credits used: ${credits.used}.`);
  }

  // 5. Diff every cell, apply the rules and write the outputs.
  const { cells, records } = diffAll(crm, results, mapping, rules);
  const statuses: Record<string, number> = {};
  for (const record of records) statuses[record.status] = (statuses[record.status] ?? 0) + 1;

  const columns = mapping.fields.map((field) => field.column);
  const report: RunReport = {
    runId: formatRunId(startedAt),
    status: 'completed',
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    input: options.csvPath,
    mappingFile: options.mappingPath,
    rulesFile: options.rulesPath,
    rows: crm.records.length,
    domains: { unique: crm.domains.length, fromCache: plan.cached, enriched: toEnrich.length },
    enrichment: { path: plan.path, ...(batchId ? { batchId } : {}), ...(importedBatch ? { importedBatch } : {}), statuses },
    credits,
    counts: countCells(cells, columns),
    records,
    outputs: ['review.html', 'patch.csv', 'summary.md', 'run.json'],
  };
  const runDir = join(options.outDir, report.runId);
  await writeOutputs(runDir, report, cells, columns);

  return { kind: 'done', plan, report, runDir, cells };
}
