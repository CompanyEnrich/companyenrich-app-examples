import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadTheme, parseTheme, themeSlug } from '../src/lib/theme.ts';

describe('parseTheme', () => {
  it('applies defaults to a minimal theme', () => {
    const theme = parseTheme('title: Fintech\nsemantic: fintech startups', 'fintech');
    expect(theme).toEqual({ slug: 'fintech', title: 'Fintech', semantic: 'fintech startups', companies: 20, categories: [] });
  });

  it('keeps the filter and category hints', () => {
    const theme = parseTheme(
      `title: Carbon
semantic: carbon accounting software
companies: 12
filter:
  country: [US, GB]
categories:
  - name: Measurement
    keywords: [carbon footprint, emissions]`,
      'carbon',
    );
    expect(theme.filter).toEqual({ country: ['US', 'GB'] });
    expect(theme.companies).toBe(12);
    expect(theme.categories).toEqual([{ name: 'Measurement', keywords: ['carbon footprint', 'emissions'] }]);
  });

  it('names every invalid field in one error', () => {
    const attempt = () => parseTheme('semantic: x\ncompanies: 500\ncategories:\n  - name: A\n    keywords: []', 'bad');
    expect(attempt).toThrow(/title/);
    expect(attempt).toThrow(/companies/);
    expect(attempt).toThrow(/categories\.0\.keywords: list at least one keyword/);
  });

  it('rejects unknown keys so typos do not pass silently', () => {
    expect(() => parseTheme('title: A\nsemantic: abc\ncompanys: 10', 'typo')).toThrow(/companys/);
  });

  it('rejects unknown filter fields and suggests the right one', () => {
    const attempt = () => parseTheme('title: A\nsemantic: abc\nfilter:\n  industry: Software\n  countries: US\n  foundedyear: {min: 2020}', 'filters');
    expect(attempt).toThrow(/filter\.industry: not a v2 company search filter field; use naicsCodes .*industries\.list\(\).* or categories/);
    expect(attempt).toThrow(/filter\.countries: .*use country/);
    expect(attempt).toThrow(/filter\.foundedyear: .*use foundedYear/);
  });

  it('accepts every real filter field', () => {
    const theme = parseTheme('title: A\nsemantic: abc\nfilter:\n  naicsCodes: ["5112"]\n  employees: [11-50]\n  require: linkedin', 'ok');
    expect(Object.keys(theme.filter!)).toEqual(['naicsCodes', 'employees', 'require']);
  });

  it('rejects duplicate category names', () => {
    const yaml = 'title: A\nsemantic: abc\ncategories:\n  - {name: Tax, keywords: [tax]}\n  - {name: tax, keywords: [vat]}';
    expect(() => parseTheme(yaml, 'dupes')).toThrow(/unique/);
  });

  it('reports YAML syntax errors without a stack trace', () => {
    expect(() => parseTheme('title: [unclosed', 'broken')).toThrow(/not valid YAML/);
  });

  it('rejects an empty file', () => {
    expect(() => parseTheme('', 'empty')).toThrow(/title/);
  });
});

describe('themeSlug', () => {
  it('uses the file name', () => {
    expect(themeSlug('themes/ai-agents-for-finance.yaml')).toBe('ai-agents-for-finance');
    expect(themeSlug('/tmp/My Theme.YML')).toBe('my-theme');
  });
});

describe('shipped themes', () => {
  it('all parse', async () => {
    const files = (await readdir(new URL('../themes/', import.meta.url))).filter((file) => file.endsWith('.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) await expect(loadTheme(new URL(`../themes/${file}`, import.meta.url).pathname)).resolves.toBeTruthy();
  });

  it('a missing file is a clear error', async () => {
    await expect(loadTheme('themes/nope.yaml')).rejects.toThrow('Cannot read theme file themes/nope.yaml');
  });
});
