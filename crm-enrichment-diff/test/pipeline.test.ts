import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePatchCsv } from '../src/lib/patch.js';
import { CreditCapError, runDiff, type DiffOptions } from '../src/lib/pipeline.js';
import type { FailedRun, RunReport } from '../src/lib/report.js';
import { BATCH_ID, exampleMappingPath, exampleRulesPath, fakeApi, fixtureCsvPath } from './fake-api.js';

async function setup(overrides: Partial<DiffOptions> = {}) {
  const outDir = await mkdtemp(join(tmpdir(), 'crm-diff-run-'));
  const options: DiffOptions = {
    csvPath: fixtureCsvPath,
    mappingPath: exampleMappingPath,
    rulesPath: exampleRulesPath,
    outDir,
    maxCredits: 60,
    dryRun: false,
    forceBulk: false,
    pollIntervalMs: 0,
    ...overrides,
  };
  const api = fakeApi();
  const lines: string[] = [];
  let clock = Date.parse('2026-11-11T09:00:00Z');
  const deps = {
    createClient: () => api.client,
    hasApiKey: true,
    log: (line: string) => lines.push(line),
    now: () => new Date((clock += 1000)),
  };
  return { options, api, lines, deps, outDir };
}

describe('runDiff', () => {
  it('enriches each unique domain once and writes the four outputs', async () => {
    const { options, api, deps } = await setup();
    const result = await runDiff(options, deps);
    if (result.kind !== 'done') throw new Error('expected a full run');

    // 5 unique domains (twilio.com twice, one row without a domain) in a single batch request.
    expect(api.paidCalls()).toHaveLength(1);
    expect(api.paidCalls()[0]?.body).toMatchObject({
      domains: ['twilio.com', 'atlassian.com', 'zoom.us', 'unknown-company.example'],
    });
    expect((await readdir(result.runDir)).sort()).toEqual(['patch.csv', 'review.html', 'run.json', 'summary.md']);

    const report: RunReport = JSON.parse(await readFile(join(result.runDir, 'run.json'), 'utf8'));
    expect(report.credits).toMatchObject({ estimated: 4, used: 3, cap: 60, balanceBefore: 900, balanceAfter: 900 });
    expect(report.enrichment).toMatchObject({ path: 'batch', statuses: { found: 4, 'not-found': 1, 'no-domain': 1 } });
    const dupe = report.records.find((record) => record.recordId === '106');
    expect(dupe).toMatchObject({ status: 'found', duplicateOf: ['101'] });

    const patch = parsePatchCsv(await readFile(join(result.runDir, 'patch.csv'), 'utf8'));
    expect(patch.every((row) => row.action === 'update')).toBe(true);
    expect(patch.length).toBe(report.counts.byAction.update);
    expect(patch).toContainEqual(
      expect.objectContaining({ record_id: '103', column: 'Number of Employees', change: 'fill', new_value: '5001' }),
    );

    const summary = await readFile(join(result.runDir, 'summary.md'), 'utf8');
    expect(summary).toContain('| fill |');
    expect(summary).toContain('105 No Domain Ltd (no domain): no usable domain or website in the CRM row');
    expect(summary).toContain('106 Twilio (dupe) (twilio.com): same domain as 101');
  });

  it('re-runs from the cache with no API calls at all', async () => {
    const { options, api, deps } = await setup();
    await runDiff(options, deps);
    const callsAfterFirstRun = api.calls.length;

    const second = await runDiff(options, deps);
    expect(api.calls.length).toBe(callsAfterFirstRun);
    if (second.kind !== 'done') throw new Error('expected a full run');
    expect(second.report.credits.used).toBe(0);
    expect(second.report.enrichment.path).toBe('cache-only');
    expect(second.report.domains.fromCache).toBe(4);
  });

  it('dry run makes only the free me() call and writes nothing', async () => {
    const { options, api, deps, lines, outDir } = await setup({ dryRun: true });
    const result = await runDiff(options, deps);

    expect(result).toMatchObject({ kind: 'dry-run', balance: 900, plan: { estimatedCredits: 4, path: 'batch' } });
    expect(api.calls.map((call) => call.path)).toEqual(['/v2/me']);
    expect(await readdir(outDir)).toEqual([]);
    expect(lines.join('\n')).toContain('up to 4 credits');
  });

  it('dry run without an API key still prints the plan', async () => {
    const { options, api, deps } = await setup({ dryRun: true });
    const result = await runDiff(options, { ...deps, hasApiKey: false });
    expect(result.kind).toBe('dry-run');
    expect(api.calls).toEqual([]);
  });

  it('stops before any paid call when the estimate exceeds --max-credits', async () => {
    const { options, api, deps } = await setup({ maxCredits: 3 });
    await expect(runDiff(options, deps)).rejects.toThrow(CreditCapError);
    expect(api.calls).toEqual([]);
  });

  it('writes a failure ledger, keeps paid results and prints a resume command that works', async () => {
    const { options, api, deps, lines, outDir } = await setup({ forceBulk: true });
    const failing = fakeApi(undefined, { failStreamAfter: 2 });
    await expect(runDiff(options, { ...deps, createClient: () => failing.client })).rejects.toThrow(/Enrichment failed/);

    const ledgerLine = lines.find((line) => line.startsWith('Stopped.'))!;
    expect(ledgerLine).toContain('2 results were cached');
    const ledger: FailedRun = JSON.parse(await readFile(ledgerLine.split('Ledger: ')[1]!, 'utf8'));
    expect(ledger).toMatchObject({
      status: 'failed',
      enrichment: { path: 'bulk', batchId: BATCH_ID, resultsCached: 2 },
      credits: { used: 3 },
      resumeCommand: `npm start -- diff ${fixtureCsvPath} --batch ${BATCH_ID} --mapping ${exampleMappingPath} --rules ${exampleRulesPath} --out ${outDir}`,
    });
    expect(await readdir(join(outDir, '.cache'))).toEqual(['atlassian.com.json', 'twilio.com.json']);

    // The resume command: collect the same job, then diff from the cache with no new paid call.
    const resumed = await runDiff({ ...options, forceBulk: false, batchId: BATCH_ID }, { ...deps, createClient: () => failing.client });
    expect(resumed.kind).toBe('done');
    expect(failing.paidCalls()).toHaveLength(1);
    expect(api.calls).toEqual([]);
  });

  it('keeps what an interrupted --batch collection received and writes a ledger', async () => {
    const { options, deps, lines, outDir } = await setup();
    const api = fakeApi(undefined, { failStreamAfter: 2 });
    await api.client.companies.bulkEnrichment.create({ domains: ['twilio.com', 'atlassian.com', 'zoom.us'] });
    const withApi = { ...deps, createClient: () => api.client };

    await expect(runDiff({ ...options, batchId: BATCH_ID }, withApi)).rejects.toThrow(/Collecting the bulk job failed/);
    expect(await readdir(join(outDir, '.cache'))).toEqual(['atlassian.com.json', 'twilio.com.json']);
    const ledgerLine = lines.find((line) => line.startsWith('Stopped.'))!;
    const ledger: FailedRun = JSON.parse(await readFile(ledgerLine.split('Ledger: ')[1]!, 'utf8'));
    expect(ledger).toMatchObject({ status: 'failed', enrichment: { batchId: BATCH_ID, resultsCached: 2 }, credits: { used: 0 } });
    expect(ledger.credits.note).toContain('only downloaded results');

    const resumed = await runDiff({ ...options, batchId: BATCH_ID }, withApi);
    expect(resumed.kind).toBe('done');
    expect(await readdir(join(outDir, '.cache'))).toContain('zoom.us.json');
  });

  it('uses the bulk path with --bulk and records the batch id', async () => {
    const { options, api, deps } = await setup({ forceBulk: true });
    const result = await runDiff(options, deps);
    if (result.kind !== 'done') throw new Error('expected a full run');
    expect(api.paidCalls().map((call) => call.path)).toEqual(['/v2/companies/enrich/bulk']);
    expect(result.report.enrichment.batchId).toBeDefined();
    expect(result.report.credits.used).toBe(3);
  });
});
