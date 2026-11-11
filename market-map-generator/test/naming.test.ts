import { describe, expect, it } from 'vitest';
import { categorize } from '../src/lib/categorize.ts';
import { describeTerms, distinctiveTerms, nameFromTerms } from '../src/lib/naming.ts';
import { buildCorpus } from '../src/lib/tfidf.ts';
import { wordKeys } from '../src/lib/text.ts';
import { COMPANIES, GROUPS, makeCompany, theme } from './fixtures.ts';

describe('distinctiveTerms', () => {
  const corpus = buildCorpus(COMPANIES.map((company) => ({ text: company.description! })));
  const indexesOf = (group: string[]) => COMPANIES.flatMap((company, index) => (group.includes(company.name!) ? [index] : []));

  it('finds the terms that set a group apart, as written', () => {
    const terms = distinctiveTerms(corpus, indexesOf(GROUPS.payables));
    expect(terms.slice(0, 2)).toEqual(['accounts payable', 'invoice approval']);
  });

  it('never repeats a word across terms', () => {
    const words = distinctiveTerms(corpus, indexesOf(GROUPS.close)).flatMap((term) => term.split(' '));
    expect(new Set(words).size).toBe(words.length);
  });

  it('skips excluded words, such as the theme title', () => {
    const terms = distinctiveTerms(corpus, indexesOf(GROUPS.planning), { exclude: wordKeys('Budgeting tools') });
    expect(terms.some((term) => term.includes('budgeting'))).toBe(false);
  });

  it('only uses terms shared by at least two members', () => {
    // "scenario planning" appears only in Plannr's description.
    expect(distinctiveTerms(corpus, indexesOf(GROUPS.planning))).not.toContain('scenario planning');
  });

  it('joins two picked words into the phrase they form', () => {
    const local = buildCorpus([
      { text: 'Close books. Financial controls.' },
      { text: 'Financial close automation.' },
      { text: 'Tax filing.' },
      { text: 'Tax compliance.' },
    ]);
    expect(distinctiveTerms(local, [0, 1])[0]).toBe('financial close');
  });
});

describe('nameFromTerms', () => {
  it('uses a leading phrase on its own and pairs single words', () => {
    expect(nameFromTerms(['invoice processing', 'vendors'], new Set(), 'Group 1')).toBe('Invoice Processing');
    expect(nameFromTerms(['accounting', 'reporting'], new Set(), 'Group 1')).toBe('Accounting & Reporting');
  });

  it('never reuses a taken name', () => {
    expect(nameFromTerms(['invoice processing', 'vendors'], new Set(['invoice processing']), 'Group 1')).toBe('Invoice Processing & Vendors');
    expect(nameFromTerms(['tax'], new Set(['Tax']), 'Group 2')).toBe('Group 2');
    expect(nameFromTerms([], new Set(['Group 2']), 'Group 2')).toBe('Group 2 2');
  });

  it('describes a group by its terms', () => {
    expect(describeTerms(['invoices', 'vendors'])).toBe('Common terms: invoices, vendors');
    expect(describeTerms([])).toBe('No shared terms');
  });
});

describe('categorize', () => {
  it('clusters companies without hints and names each cluster uniquely', () => {
    const { categories, method } = categorize(COMPANIES, theme());
    expect(method.kind).toBe('clusters');
    expect(categories.map((category) => category.companies.map((company) => company.name).sort())).toEqual(
      expect.arrayContaining(Object.values(GROUPS).map((group) => [...group].sort())),
    );
    expect(new Set(categories.map((category) => category.name)).size).toBe(3);
    expect(categories.every((category) => category.kind === 'cluster' && category.description.startsWith('Common terms:'))).toBe(true);
  });

  it('never names a cluster with words from the theme title', () => {
    const { categories } = categorize(COMPANIES, theme());
    for (const category of categories) expect(category.name.toLowerCase()).not.toMatch(/finance|agent|team/);
  });

  it('assigns by category hints first and sends companies that match none to Other', () => {
    const companies = [...COMPANIES, makeCompany('Treeline', 'Treeline plants forests for carbon offsets.')];
    const hints = `categories:
  - {name: Payables, keywords: [accounts payable, invoice]}
  - {name: Close, keywords: [reconciliation, month-end close]}
  - {name: Planning, keywords: [budgeting, forecasting]}
  - {name: Tax, keywords: [sales tax, vat]}`;
    const { categories, method } = categorize(companies, theme(hints));
    expect(categories.map((category) => [category.name, category.kind, category.companies.length])).toEqual([
      ['Payables', 'hint', 3],
      ['Close', 'hint', 3],
      ['Planning', 'hint', 3],
      ['Other', 'other', 1],
    ]);
    expect(method).toEqual({ kind: 'hints', unmatched: 1, emptyHints: ['Tax'] });
  });

  it('puts companies with no description or tags in Other', () => {
    const blank = makeCompany('Blankco', '', { description: undefined, industries: [], categories: [] });
    const { categories } = categorize([...COMPANIES, blank], theme());
    expect(categories.at(-1)).toMatchObject({ name: 'Other', kind: 'other', companies: [blank] });
  });

  it('uses a single box when there are too few companies to cluster', () => {
    const { categories, method } = categorize(COMPANIES.slice(0, 4), theme());
    expect(method.kind).toBe('single');
    expect(categories).toHaveLength(1);
    expect(categories[0]!.companies).toHaveLength(4);
  });

  it('keeps the description of a single company', () => {
    const { categories } = categorize([COMPANIES[0]!], theme());
    expect(categories).toHaveLength(1);
    expect(categories[0]).toMatchObject({ name: 'Accounts Payable', kind: 'cluster', companies: [COMPANIES[0]] });
  });

  it('ignores a company name inside its own description', () => {
    const named = [makeCompany('Invoicer', 'Invoicer reads invoices.'), makeCompany('Other Co', 'Reads invoices too.')];
    const { categories } = categorize(named, theme());
    expect(categories[0]!.terms).not.toContain('invoicer');
  });
});
