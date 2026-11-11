import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CategoryNamer } from '../src/lib/claude.ts';
import { describeApiError } from '../src/lib/companyenrich.ts';
import { actualSearchCredits, assertWithinBudget, estimateSearchCredits } from '../src/lib/credits.ts';
import { UsageError } from '../src/lib/errors.ts';
import { run, type Dependencies, type RunOptions } from '../src/lib/pipeline.ts';
import { COMPANIES, fakeCompanyEnrich, fakeLogoServer, theme, type FakeApiOptions } from './fixtures.ts';

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'market-map-test-'));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function setup(api: FakeApiOptions = {}, options: Partial<RunOptions> = {}, deps: Partial<Dependencies> = {}) {
  const fake = fakeCompanyEnrich(api);
  const lines: string[] = [];
  const logos = fakeLogoServer(COMPANIES.slice(0, 2).map((company) => company.logoUrl));
  const runOptions: RunOptions = { theme: theme(), companies: 20, withKeywords: false, maxCredits: 100, dryRun: false, outDir, today: '2026-11-11', ...options };
  const runDeps: Dependencies = { client: fake.client, namer: null, fetch: logos.fetch, log: (line) => lines.push(line), ...deps };
  return { fake, lines, logos, go: () => run(runOptions, runDeps) };
}

const mapDir = () => join(outDir, 'finance-2026-11-11');

describe('credits', () => {
  it('estimates 2 credits per company, 3 with keywords', () => {
    expect(estimateSearchCredits(20, false)).toBe(40);
    expect(estimateSearchCredits(20, true)).toBe(60);
  });

  it('bills one base price for an empty result', () => {
    expect(actualSearchCredits(0, true)).toBe(2);
    expect(actualSearchCredits(9, false)).toBe(18);
  });

  it('allows spend up to the cap and suggests a size that fits when over it', () => {
    expect(() => assertWithinBudget(40, 40, false)).not.toThrow();
    expect(() => assertWithinBudget(60, 50, true)).toThrow('This run could cost 60 credits, more than --max-credits 50. Nothing was spent. Use --companies 16 or raise --max-credits.');
    expect(() => assertWithinBudget(2, 1, false)).toThrow(/Raise --max-credits/);
  });
});

describe('run', () => {
  it('dry run uses only the free count and preview, and prints the estimate', async () => {
    const { fake, lines, go } = setup({}, { dryRun: true });
    const result = await go();
    expect(result).toMatchObject({ kind: 'dry-run', estimate: 40 });
    expect(fake.calls.map((call) => call.path)).toEqual(['/v2/companies/search/count', '/v2/companies/search/preview']);
    expect(lines).toContain('API interpretation: boosts categories b2b');
    expect(lines).toContain('Estimate: 20 companies x 2 credits = up to 40 credits (--max-credits 100)');
    expect(lines.at(-1)).toBe('Dry run: 0 credits spent.');
    expect(existsSync(mapDir())).toBe(false);
  });

  it('dry run still works when the plan has no previews', async () => {
    const { fake, lines, go } = setup({ previewStatus: 403 }, { dryRun: true, maxCredits: 10 });
    await expect(go()).resolves.toMatchObject({ kind: 'dry-run' });
    expect(fake.paidCalls()).toHaveLength(0);
    expect(lines).toContain('Free preview is not available on this plan; skipped.');
    expect(lines).toContain('A real run would stop before searching: 40 credits is over --max-credits 10.');
  });

  it('stops before the paid search when the estimate is over --max-credits', async () => {
    const { fake, go } = setup({}, { maxCredits: 30 });
    await expect(go()).rejects.toThrow(UsageError);
    await expect(go()).rejects.toThrow('Use --companies 15 or raise --max-credits');
    expect(fake.paidCalls()).toHaveLength(0);
    expect(existsSync(mapDir())).toBe(false);
  });

  it('skips the paid search when the free count is 0', async () => {
    const { fake, go } = setup({ count: 0 });
    await expect(go()).resolves.toEqual({ kind: 'no-results', creditsSpent: 0 });
    expect(fake.paidCalls()).toHaveLength(0);
  });

  it('reports the base price when the paid search comes back empty', async () => {
    const { go } = setup({ results: [] });
    await expect(go()).resolves.toEqual({ kind: 'no-results', creditsSpent: 2 });
  });

  it('checks the output folder before paying', async () => {
    const blocker = join(outDir, 'a-file');
    await writeFile(blocker, '');
    const { fake, go } = setup({}, { outDir: join(blocker, 'nested') });
    await expect(go()).rejects.toThrow(/Cannot write to the output folder/);
    expect(fake.paidCalls()).toHaveLength(0);
  });

  it('checks every file it will write before paying, not just the folder', async () => {
    await mkdir(join(mapDir(), 'companies.json'), { recursive: true });
    const { fake, go } = setup({}, { companies: 9 });
    await expect(go()).rejects.toThrow(`${join(mapDir(), 'companies.json')} exists and is not a file`);
    expect(fake.paidCalls()).toHaveLength(0);
  });

  it('saves paid results to the temp folder when the output folder fails after paying', async () => {
    const blockSave = () => mkdir(join(mapDir(), 'companies.json'), { recursive: true }).then(() => undefined);
    const { lines, go } = setup({ onSearch: blockSave }, { companies: 9 });
    const result = await go();
    const notice = lines.find((line) => line.startsWith('Could not write'))!;
    const fallback = notice.match(/saved the paid results to (\S+) instead/)![1]!;
    try {
      expect(JSON.parse(await readFile(fallback, 'utf8')).companies).toHaveLength(9);
      expect(result).toMatchObject({ kind: 'map', creditsSpent: 18 });
      expect(result.kind === 'map' && result.files).toContain(fallback);
    } finally {
      await rm(fallback, { force: true });
    }
  });

  it('makes a map end to end and writes all four files', async () => {
    const { fake, lines, go } = setup({}, { companies: 9 });
    const result = await go();
    if (result.kind !== 'map') throw new Error(`expected a map, got ${result.kind}`);

    expect(fake.paidCalls().map((call) => call.body)).toEqual([{ semantic: { query: 'AI agents for finance teams' }, pageSize: 9 }]);
    expect(result.creditsSpent).toBe(18);
    expect(result.categories).toHaveLength(3);
    expect(result.files.map((file) => file.replace(`${mapDir()}/`, '')).sort()).toEqual(['companies.csv', 'companies.json', 'map.html', 'map.svg']);
    expect(lines).toContain('Logos: 2 embedded, 7 shown as initials');
    expect(lines).toContain('Claude naming: off (set ANTHROPIC_API_KEY to enable); using term-based names');

    const html = await readFile(join(mapDir(), 'map.html'), 'utf8');
    for (const category of result.categories) expect(html).toContain(category.name.replace(/&/g, '&amp;'));
    const saved = JSON.parse(await readFile(join(mapDir(), 'companies.json'), 'utf8'));
    expect(saved).toMatchObject({ theme: 'finance', query: 'AI agents for finance teams', fetchedOn: '2026-11-11' });
    expect(saved.companies).toHaveLength(9);
  });

  it('asks for the keywords expansion and prices it', async () => {
    const { fake, go } = setup({}, { companies: 9, withKeywords: true });
    const result = await go();
    expect(fake.paidCalls()[0]!.body.expand).toEqual(['keywords']);
    expect(result).toMatchObject({ kind: 'map', creditsSpent: 27 });
  });

  it('re-renders from a saved companies.json without any API call', async () => {
    await setup({}, { companies: 9 }).go();
    const saved = join(mapDir(), 'companies.json');
    const { fake, go } = setup({}, { from: saved, today: '2026-11-12' }, { client: undefined });
    const result = await go();
    expect(result).toMatchObject({ kind: 'map', creditsSpent: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(join(outDir, 'finance-2026-11-12', 'companies.json'))).toBe(true);
  });

  it('refuses saved data from another theme, or a file that is not saved data', async () => {
    await setup({}, { companies: 9 }).go();
    const saved = join(mapDir(), 'companies.json');
    const otherTheme = { ...theme(), slug: 'carbon' };
    await expect(setup({}, { from: saved, theme: otherTheme }).go()).rejects.toThrow('was saved for theme "finance", not "carbon"');
    await expect(setup({}, { from: join(mapDir(), 'map.html') }).go()).rejects.toThrow(/Cannot read/);
  });

  it('validates the whole shape of saved data before using it', async () => {
    const write = async (content: unknown) => {
      const path = join(outDir, 'saved.json');
      await writeFile(path, JSON.stringify(content));
      return path;
    };
    const valid = { theme: 'finance', query: 'q', fetchedOn: '2026-11-11', companies: COMPANIES };
    for (const broken of [null, [], { ...valid, companies: null }, { ...valid, companies: [null] }, { ...valid, companies: [{ ...COMPANIES[0], description: 5 }] }]) {
      await expect(setup({}, { from: await write(broken) }).go()).rejects.toThrow(UsageError);
    }
    await expect(setup({}, { from: await write(valid) }, { client: undefined }).go()).resolves.toMatchObject({ kind: 'map' });
  });

  it('keeps what was paid for when a later step fails', async () => {
    const failingNamer: CategoryNamer = async () => {
      throw new Error('disk on fire');
    };
    const { lines, go } = setup({}, { companies: 9 }, { namer: failingNamer });
    await expect(go()).rejects.toThrow('disk on fire');
    expect(existsSync(join(mapDir(), 'companies.json'))).toBe(true);
    expect(lines.at(-1)).toBe(`18 credits were spent. The companies are saved: rerun with --from ${join(mapDir(), 'companies.json')} to finish for free.`);
  });

  it('uses Claude names when a namer is available', async () => {
    const namer: CategoryNamer = async (_title, clusters) => ({
      ok: true,
      labels: clusters.map((_, index) => ({ label: `Segment ${index + 1}`, description: 'Named by a fake Claude.' })),
    });
    const result = await setup({}, { companies: 9 }, { namer }).go();
    expect(result.kind === 'map' && result.categories.map((category) => category.name)).toEqual(['Segment 1', 'Segment 2', 'Segment 3']);
    expect(await readFile(join(mapDir(), 'map.svg'), 'utf8')).toContain('names by Claude');
  });

  it('turns a rejected API key into a one-line message', async () => {
    const { go } = setup({ failWith: 401 });
    const error = await go().catch((caught: unknown) => caught);
    expect(describeApiError(error)).toBe('CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard');
  });

  it('turns an invalid theme filter into a one-line message before any paid call', async () => {
    const { fake, go } = setup({ failWith: 422 });
    const error = await go().catch((caught: unknown) => caught);
    expect(describeApiError(error)).toMatch(/^CompanyEnrich rejected the query \(422\): Request failed\. Check the theme's "filter"/);
    expect(fake.paidCalls()).toHaveLength(0);
  });
});
