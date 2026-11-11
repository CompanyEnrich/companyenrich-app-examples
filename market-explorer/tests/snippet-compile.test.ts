import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { emptyFilterState, toApiFilter } from '@/lib/filter';
import type { CompanyFilter } from '@/lib/options';
import { sdkSnippet } from '@/lib/snippets';

const root = resolve(__dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'market-explorer-snippet-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Type-checks `code` with the project's tsc against the installed SDK's real types. */
function typecheck(name: string, code: string): { ok: boolean; output: string } {
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'snippet.ts'), code);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2023', 'DOM'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        paths: { '@companyenrich/sdk': [join(root, 'node_modules/@companyenrich/sdk/dist/index.d.ts')] },
      },
      files: ['snippet.ts'],
    }),
  );
  const result = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe('exported SDK snippet', () => {
  it('compiles against the real SDK types for a filter using every kind of field', () => {
    const filter = toApiFilter({
      ...emptyFilterState(),
      countries: [{ value: 'DE', label: 'Germany' }],
      regions: [{ value: 'Europe/Western Europe', label: 'Western Europe' }],
      states: [{ value: 4845, label: 'California' }],
      industries: [{ name: 'Software', naicsCodes: ['5112'] }],
      employees: ['51-200', '201-500'],
      revenue: ['10m-50m'],
      types: ['private'],
      categories: ['b2b', 'saas'],
      categoryMatch: 'any',
      technologies: { all: ['stripe'], any: ['react'], exclude: ['shopify'] },
      keywords: { all: ['fintech'], any: [], exclude: [] },
      foundedYear: { min: 2015, max: 2020 },
      fundingRounds: ['series_a'],
      fundingYear: { min: 2024 },
      fundingAmount: { min: 10_000_000 },
      workforceGrowth: { period: 'y1', department: 'engineering_technical', minPercent: 20 },
    });
    const result = typecheck('valid', sdkSnippet(filter));
    expect(result.output).toBe('');
    expect(result.ok).toBe(true);
  }, 30_000);

  it('is a real check: an invalid enum value fails to compile', () => {
    const result = typecheck('invalid', sdkSnippet({ employees: ['huge'] } as unknown as CompanyFilter));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('TS2322');
  }, 30_000);
});
