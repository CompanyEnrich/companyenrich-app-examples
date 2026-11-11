import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '@companyenrich/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../src/lib/errors.js';
import { runPipeline, type PipelineOptions } from '../src/lib/pipeline.js';
import { fakeApi, NOW } from './fake-api.js';

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'competitor-displacement-'));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function options(overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    competitor: 'Zendesk',
    mine: 'intercom',
    countries: [],
    employees: [],
    categories: [],
    accounts: 5,
    contacts: 1,
    persona: undefined,
    withFunding: false,
    maxCredits: 40,
    exclude: [],
    dryRun: false,
    outDir,
    ...overrides,
  };
}

async function run(overrides: Partial<PipelineOptions> = {}, api = fakeApi()) {
  const lines: string[] = [];
  const record = await runPipeline(options(overrides), { client: api.client, log: (line) => lines.push(line), now: () => NOW });
  return { api, record, output: lines.join('\n') };
}

describe('runPipeline', () => {
  it('dry run: real free counts, an estimate, and no paid calls', async () => {
    const { api, record, output } = await run({ dryRun: true });

    expect(api.paidCalls()).toHaveLength(0);
    expect(record.status).toBe('dry-run');
    expect(record.market.targets).toBe(7);
    expect(record.tiers).toMatchObject({ 1: 2, 2: 2, 3: 3 });
    expect(record.estimate.map((line) => line.credits)).toEqual([5, 10]);
    expect(record.credits.spent).toBe(0);
    expect(output).toContain('Dry run: stopping before paid steps.');
    expect(record.files).toEqual(['report.md', 'run.json']);
  });

  it('full run: ranked accounts, persona then fallback contacts, and a ledger that matches the bill', async () => {
    const { api, record } = await run();

    expect(record.status).toBe('complete');
    expect(record.accounts.map((a) => `${a.tier}:${a.company.domain}`)).toEqual([
      '1:alpha.example',
      '1:bravo.example',
      '2:charlie.example',
      '2:delta.example',
      '3:echo.example',
    ]);
    // alpha and charlie have support people; bravo only has the fallback (VP Operations); the rest have nobody.
    expect(record.contacts.map((c) => `${c.account.company.domain}:${c.match}`)).toEqual([
      'alpha.example:persona',
      'bravo.example:fallback',
      'charlie.example:persona',
    ]);
    expect(api.callsTo('/v2/people/search')).toHaveLength(3); // no paid search where the free count was 0
    expect(record.credits.spent).toBe(api.charged());
    expect(record.credits.spent).toBe(5 + 3 * 2);
    expect(record.credits.balanceBefore! - record.credits.balanceAfter!).toBe(11);
  });

  it('writes the report, both CSVs and run.json with the ledger', async () => {
    const { record } = await run({ withFunding: true });
    const dir = record.outputDir!;
    expect(dir).toBe(join(outDir, '20261111-093000-zendesk-not-intercom'));
    expect((await readdir(dir)).sort()).toEqual(['accounts.csv', 'contacts.csv', 'report.md', 'run.json']);

    const json = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
    expect(json.credits.spent).toBe(10 + 6);
    expect(json.credits.entries.map((entry: { step: string }) => entry.step)).toEqual(['accounts', 'accounts', 'accounts', 'contacts', 'contacts', 'contacts']);

    const accounts = (await readFile(join(dir, 'accounts.csv'), 'utf8')).trim().split('\n');
    expect(accounts[0]).toBe('rank,tier,why_now,name,domain,country,employees,industry,latest_round,total_funding_usd,linkedin_url');
    expect(accounts[1]).toContain('alpha.example');
    expect(accounts[1]).toContain('"Series B, $20M, 2025-09-15"');
    const contacts = (await readFile(join(dir, 'contacts.csv'), 'utf8')).trim().split('\n');
    expect(contacts).toHaveLength(4);
  });

  it('stops before any paid call when the estimate is over --max-credits, and still writes the free report', async () => {
    const { api, record } = await run({ maxCredits: 10 });
    expect(record.status).toBe('stopped-by-budget');
    expect(record.note).toContain('above --max-credits 10');
    expect(api.paidCalls()).toHaveLength(0);
    expect(record.files).toEqual(['report.md', 'run.json']);
    const report = await readFile(join(record.outputDir!, 'report.md'), 'utf8');
    expect(report).toContain('> Stopped before spending');
    expect(report).toContain('| contacts | up to 5 people x 2 | 10 |');
  });

  it('skips every paid step when no company matches', async () => {
    const { api, record } = await run({ countries: ['JP'] });
    expect(record.status).toBe('no-targets');
    expect(api.paidCalls()).toHaveLength(0);
    expect(api.callsTo('/v2/people/search/count')).toHaveLength(0);
  });

  it('stops on an unknown technology before counting anything', async () => {
    const api = fakeApi();
    await expect(run({ competitor: 'zen' }, api)).rejects.toThrow(UsageError);
    expect(api.callsTo('/v2/companies/search/count')).toHaveLength(0);
  });

  it('rejects the same technology on both sides', async () => {
    await expect(run({ competitor: 'zendesk', mine: 'Zendesk' })).rejects.toThrow('must be different technologies');
  });

  it('keeps the ledger of what was spent when a paid call fails, then rethrows', async () => {
    const api = fakeApi({ fail: (call) => (call.path === '/v2/people/search' ? 500 : undefined) });
    await expect(run({}, api)).rejects.toBeInstanceOf(ServerError);
    const [runDir] = await readdir(outDir);
    const json = JSON.parse(await readFile(join(outDir, runDir!, 'run.json'), 'utf8'));
    expect(json.status).toBe('failed');
    expect(json.credits.spent).toBe(5);
  });
});

describe('partial failures', () => {
  async function readRun() {
    const [runDir] = await readdir(outDir);
    const dir = join(outDir, runDir!);
    const json = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
    const csv = (name: string) => readFile(join(dir, name), 'utf8').then((text) => text.trim().split('\n').slice(1));
    return { json, accounts: await csv('accounts.csv'), contacts: await csv('contacts.csv') };
  }

  it('keeps accounts from pages that succeeded when a later company search fails', async () => {
    const api = fakeApi({ fail: (call, nth) => (call.path === '/v2/companies/search' && nth === 1 ? 500 : undefined) });
    await expect(run({}, api)).rejects.toBeInstanceOf(ServerError);

    const saved = await readRun();
    expect(saved.json.status).toBe('failed');
    expect(saved.json.accounts.map((a: { domain: string }) => a.domain)).toEqual(['alpha.example', 'bravo.example']);
    expect(saved.accounts).toHaveLength(2);
    expect(saved.json.credits.spent).toBe(2);
    expect(saved.json.credits.spent).toBe(api.charged());
  });

  it('lets in-flight people searches finish after one fails, and records every credit and contact', async () => {
    const api = fakeApi({
      fail: (call) => (call.path === '/v2/people/search' && call.body?.filter.domain === 'alpha.example' ? 500 : undefined),
      latency: (call) => (call.path === '/v2/people/search' ? 20 : 0),
    });
    await expect(run({}, api)).rejects.toBeInstanceOf(ServerError);

    const saved = await readRun();
    expect(saved.json.credits.spent).toBe(api.charged());
    expect(saved.json.credits.spent).toBe(5 + 2 * 2); // accounts, plus bravo and charlie
    expect(saved.contacts.map((row) => row.split(',')[3])).toEqual(['bravo.example', 'charlie.example']);
  });

  it('starts no new paid searches after a failure', async () => {
    const companies = Array.from({ length: 12 }, (_, i) => ({ domain: `c${i}.example`, technologies: ['zendesk'], country: 'US', employees: '51-200' }));
    const people = companies.map((c) => ({ domain: c.domain, department: 'operations/customer-service-support', seniority: 'manager', position: 'Support Manager' }));
    const api = fakeApi({ companies, people, fail: (call, nth) => (call.path === '/v2/people/search' && nth === 0 ? 500 : undefined) });
    await expect(run({ accounts: 12 }, api)).rejects.toBeInstanceOf(ServerError);
    expect(api.callsTo('/v2/people/search')).toHaveLength(4); // the first wave of 4, nothing after the failure
    expect((await readRun()).json.credits.spent).toBe(api.charged());
  });

  it('writes the run even when the closing balance cannot be read', async () => {
    const api = fakeApi({ fail: (call, nth) => (call.path === '/v2/me' && nth === 1 ? 503 : undefined) });
    const { record, output } = await run({}, api);
    expect(record.status).toBe('complete');
    expect(record.credits.balanceAfter).toBeUndefined();
    expect(output).toContain('Could not read the closing balance');
    const saved = await readRun();
    expect(saved.json.credits.spent).toBe(11);
    expect(saved.contacts).toHaveLength(3);
  });

  it('rejects an --out that is a file before any paid call', async () => {
    const file = join(outDir, 'not-a-folder');
    await writeFile(file, 'x');
    const api = fakeApi();
    const error = await run({ outDir: file }, api).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(/^Cannot write to --out ".*not-a-folder": ENOTDIR/);
    expect(api.paidCalls()).toHaveLength(0);
    expect(api.callsTo('/v2/companies/search/count')).toHaveLength(0);
  });
});

describe('--exclude', () => {
  it('leaves excluded domains out of every count and search', async () => {
    const { api, record } = await run({ exclude: ['alpha.example', 'charlie.example'] });
    expect(record.market.targets).toBe(5);
    expect(record.accounts.map((a) => a.company.domain)).toEqual(['bravo.example', 'delta.example', 'echo.example', 'foxtrot.example', 'golf.example']);
    for (const call of api.callsTo('/v2/companies/search')) {
      expect(call.body?.filter.domain.notIn).toEqual(expect.arrayContaining(['alpha.example', 'charlie.example']));
    }
  });

  it("refuses a list that would pass the plan's term limit, before spending", async () => {
    const api = fakeApi();
    const exclude = Array.from({ length: 996 }, (_, i) => `d${i}.example`);
    await expect(run({ exclude }, api)).rejects.toThrow("passes your plan's limit of 1000 terms");
    expect(api.calls.map((call) => call.path)).toEqual(['/v2/me']);
  });
});
