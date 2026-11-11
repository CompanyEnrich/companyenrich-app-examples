import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../src/lib/credits.js';
import { UsageError } from '../src/lib/errors.js';
import { parseCsv } from '../src/lib/csv.js';
import { runPipeline, type PipelineOptions } from '../src/lib/pipeline.js';
import { CUSTOMERS, fakeApi, json } from './fake-api.js';

let dir: string;
let options: PipelineOptions;
let clock = 0;
// Distinct run ids for back-to-back runs in the same output folder.
const now = () => new Date(Date.UTC(2026, 10, 11, 9, 0, clock++));
const quiet = () => {};
// The one run folder in the output directory (the cache folder starts with a dot).
const onlyRunDir = async () => {
  const [runDir] = (await readdir(options.outDir)).filter((name) => !name.startsWith('.'));
  return path.join(options.outDir, runDir as string);
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'customers-to-pipeline-'));
  const csvPath = path.join(dir, 'customers.csv');
  const rows = ['domain', ...CUSTOMERS.map((company) => `https://www.${company.domain}/`), 'ghost.example', 'n/a'];
  await writeFile(csvPath, rows.join('\n'));
  options = {
    csvPath,
    accounts: 3,
    contacts: 4,
    persona: 'sales-leader',
    withTech: false,
    minShare: 0.3,
    maxCredits: 60,
    dryRun: false,
    outDir: path.join(dir, 'output'),
  };
});

const peopleAvailable = { 'kilo.example': 2, 'lima.example': 0, 'mike.example': 5 };

describe('runPipeline', () => {
  it('runs end to end and writes every output file', async () => {
    const api = fakeApi({ peopleAvailable });
    const run = await runPipeline(options, { client: api.client, log: quiet, now });

    expect(run.status).toBe('completed');
    expect(run.files.sort()).toEqual(['accounts.csv', 'contacts.csv', 'icp.json', 'profile.md', 'run.json']);
    expect(run.customers).toMatchObject({ domains: 11, enriched: 10, notFound: ['ghost.example'], invalidRows: [{ row: 13, value: 'n/a' }] });

    // 10 found x 1 + 3 lookalikes x 5 + 4 people x 2 (allocated 2, 0, 2 across the accounts)
    expect(run.credits.spent).toBe(33);
    expect(run.credits.balanceBefore! - run.credits.balanceAfter!).toBe(33);
    expect(api.callsTo('/v2/people/search').map((call) => [call.body?.filter.domain, call.body?.pageSize])).toEqual([
      ['kilo.example', 2],
      ['mike.example', 2],
    ]);

    const accounts = parseCsv(await readFile(path.join(run.outputDir, 'accounts.csv'), 'utf8'));
    expect(accounts.map((row) => row[1])).toEqual(['domain', 'kilo.example', 'lima.example', 'mike.example']);
    expect(accounts[1]?.[7]).toBe('industry; employees; country; foundedYear');
    const contacts = parseCsv(await readFile(path.join(run.outputDir, 'contacts.csv'), 'utf8'));
    expect(contacts).toHaveLength(5);

    const icp = JSON.parse(await readFile(path.join(run.outputDir, 'icp.json'), 'utf8'));
    expect(icp.filter.country).toEqual(['US']);
    expect(await readFile(path.join(run.outputDir, 'profile.md'), 'utf8')).toContain('**1,234** companies match the ICP');
  });

  it('excludes every customer from the lookalike search with domain.notIn, and counts before searching', async () => {
    const api = fakeApi({ peopleAvailable });
    await runPipeline(options, { client: api.client, log: quiet, now });

    const lookalikeCount = api.callsTo('/v2/companies/search/count').find((call) => call.body?.lookalike);
    const [search] = api.callsTo('/v2/companies/search');
    expect(lookalikeCount?.body).toEqual({ lookalike: search?.body?.lookalike, filter: search?.body?.filter });
    expect(search?.body?.filter.domain.notIn).toEqual(expect.arrayContaining(CUSTOMERS.map((company) => company.domain)));
    expect(search?.body?.lookalike.domains[0]).toBe('alpha.example');
    expect(search?.body?.pageSize).toBe(3);
  });

  it('reads enrichment from the cache on a re-run, so it is not billed again', async () => {
    await runPipeline(options, { client: fakeApi({ peopleAvailable }).client, log: quiet, now });

    const api = fakeApi({ peopleAvailable });
    const run = await runPipeline(options, { client: api.client, log: quiet, now });

    // Only the domain that was not found is asked for again (not-found results are free).
    expect(api.callsTo('/v2/companies/enrich/batch').map((call) => call.body?.domains)).toEqual([['ghost.example']]);
    expect(run.customers.fromCache).toBe(10);
    expect(run.credits.ledger.find((entry) => entry.step === 'enrich')?.credits).toBe(0);
    expect(run.credits.spent).toBe(23);
  });

  it('stops before any paid call when the estimate is above --max-credits', async () => {
    const api = fakeApi({ peopleAvailable });
    // Estimate: 11 to enrich + 3 x 5 + 4 x 2 = 34
    await expect(runPipeline({ ...options, maxCredits: 30 }, { client: api.client, log: quiet, now })).rejects.toThrow(BudgetExceededError);
    expect(api.paidCalls()).toEqual([]);

    const record = JSON.parse(await readFile(path.join(await onlyRunDir(), 'run.json'), 'utf8'));
    expect(record.status).toBe('stopped');
    expect(record.credits.spent).toBe(0);
  });

  it('dry run without a cache spends nothing and makes no search calls', async () => {
    const api = fakeApi({ peopleAvailable });
    const lines: string[] = [];
    const run = await runPipeline({ ...options, dryRun: true }, { client: api.client, log: (line) => lines.push(line), now });

    expect(run.status).toBe('dry-run');
    expect(api.paidCalls()).toEqual([]);
    expect(api.callsTo('/v2/companies/search/count')).toEqual([]);
    expect(lines.join('\n')).toContain('A full run with these flags costs up to 34 credits.');
  });

  it('dry run with a cache runs the free counts only', async () => {
    await runPipeline(options, { client: fakeApi({ peopleAvailable }).client, log: quiet, now });

    const api = fakeApi({ peopleAvailable });
    const run = await runPipeline({ ...options, dryRun: true }, { client: api.client, log: quiet, now });

    expect(run.status).toBe('dry-run');
    expect(api.paidCalls()).toEqual([]);
    expect(run.counts.market).toEqual({ count: 1234, total: 1234 });
    expect(run.counts.lookalikePool).toEqual({ count: 40, total: 40 });
    expect(run.credits.balanceBefore).toBe(run.credits.balanceAfter);
  });

  it('reuses an edited ICP with --icp and skips profiling', async () => {
    const icpPath = path.join(dir, 'icp.json');
    await writeFile(icpPath, JSON.stringify({ filter: { country: ['GB'], employees: ['51-200'] } }));
    const api = fakeApi({ peopleAvailable });
    const run = await runPipeline({ ...options, icpPath }, { client: api.client, log: quiet, now });

    expect(run.files).not.toContain('profile.md');
    expect(api.callsTo('/v2/companies/search/count')[0]?.body).toEqual({ filter: { country: ['GB'], employees: ['51-200'] } });
    // hotel and india match both edited dimensions, so they lead the seeds
    expect(run.seeds?.slice(0, 2)).toEqual(['hotel.example', 'india.example']);
  });

  it('skips the paid search when no lookalike matches', async () => {
    const api = fakeApi({ peopleAvailable, lookalikePool: 0 });
    const run = await runPipeline(options, { client: api.client, log: quiet, now });

    expect(run.status).toBe('completed');
    expect(api.callsTo('/v2/companies/search')).toEqual([]);
    expect(run.files).not.toContain('accounts.csv');
  });

  describe('an invalid --icp file stops the run before any paid request', () => {
    it.each([
      ['a missing file', undefined],
      ['broken JSON', '{"filter": '],
      ['no filter object', '{"country": ["US"]}'],
      ['an unknown filter field', '{"filter": {"industry": "Software"}}'],
    ])('%s', async (_case, content) => {
      const icpPath = path.join(dir, 'icp.json');
      if (content !== undefined) await writeFile(icpPath, content);
      const api = fakeApi({ peopleAvailable });

      await expect(runPipeline({ ...options, icpPath }, { client: api.client, log: quiet, now })).rejects.toThrow(UsageError);
      expect(api.calls).toEqual([]);
    });

    it('a filter the API rejects (checked with the free count)', async () => {
      const icpPath = path.join(dir, 'icp.json');
      await writeFile(icpPath, JSON.stringify({ filter: { employees: ['huge'] } }));
      const api = fakeApi({
        peopleAvailable,
        override: (route, body) =>
          route === '/v2/companies/search/count' && body?.filter?.employees?.includes('huge')
            ? json({ title: 'Bad Request', status: 400, detail: 'Invalid employees value' }, 400)
            : undefined,
      });

      await expect(runPipeline({ ...options, icpPath }, { client: api.client, log: quiet, now })).rejects.toThrow(
        /rejected the filter in .*icp\.json \(400\): Invalid employees value/,
      );
      expect(api.paidCalls()).toEqual([]);
    });
  });

  it('keeps contacts and the ledger already paid for when a later people search fails', async () => {
    const api = fakeApi({
      peopleAvailable,
      override: (route, body) =>
        route === '/v2/people/search' && body?.filter?.domain === 'mike.example'
          ? json({ title: 'Server Error', status: 500 }, 500)
          : undefined,
    });

    await expect(runPipeline(options, { client: api.client, log: quiet, now })).rejects.toThrow();

    const output = await onlyRunDir();
    const contacts = parseCsv(await readFile(path.join(output, 'contacts.csv'), 'utf8'));
    expect(contacts.slice(1).map((row) => row[0])).toEqual(['kilo.example', 'kilo.example']);
    const record = JSON.parse(await readFile(path.join(output, 'run.json'), 'utf8'));
    expect(record.status).toBe('failed');
    expect(record.credits.spent).toBe(10 + 15 + 4); // enrichment, lookalikes, the 2 people found at kilo
  });
});
