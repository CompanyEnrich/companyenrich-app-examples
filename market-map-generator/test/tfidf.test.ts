import { describe, expect, it } from 'vitest';
import { extractTerms, stem, termKey, titleCase, wordKeys } from '../src/lib/text.ts';
import { buildCorpus, cosine, mean, norm, normalize, TAG_WEIGHT } from '../src/lib/tfidf.ts';

describe('text', () => {
  it('stems common plurals and leaves other words alone', () => {
    expect(['invoices', 'companies', 'processes', 'taxes', 'business', 'analysis', 'saas', 'fp&a', 'ap'].map(stem)).toEqual([
      'invoice', 'company', 'process', 'tax', 'business', 'analysis', 'saas', 'fp&a', 'ap',
    ]);
  });

  it('extracts words and adjacent two-word phrases, never across punctuation or stopwords', () => {
    const terms = extractTerms('Accounts payable, invoices and the e-invoicing API.');
    expect(terms.map((term) => term.key)).toEqual(['account', 'payable', 'account payable', 'invoice', 'e-invoicing', 'api', 'e-invoicing api']);
    expect(terms.find((term) => term.key === 'account payable')?.surface).toBe('accounts payable');
  });

  it('gives a two-part hyphenated word the same key as the two words written apart', () => {
    expect(termKey('net-zero')).toBe('net zero');
    expect(extractTerms('reach net zero').map((term) => term.key)).toContain('net zero');
    expect(extractTerms('a net-zero plan').map((term) => [term.key, term.surface])).toContainEqual(['net zero', 'net-zero']);
    expect(termKey('order-to-cash')).toBe('order-to-cash');
    expect(termKey('e-invoicing')).toBe('e-invoicing');
  });

  it('drops numbers, one-letter words and ignored stems', () => {
    const keys = extractTerms("Ledgerly's 2024 invoice tool: a payables agent", new Set(['ledgerly'])).map((term) => term.key);
    expect(keys).toEqual(['invoice', 'payable', 'agent', 'payable agent']);
  });

  it('collects word stems for ignore lists', () => {
    expect(wordKeys('Safebooks AI, Inc.')).toEqual(new Set(['safebook', 'ai', 'inc']));
  });

  it('title-cases names, keeping acronyms and hyphenated terms readable', () => {
    expect(titleCase('accounts payable')).toBe('Accounts Payable');
    expect(titleCase('fp&a')).toBe('FP&A');
    expect(titleCase('order-to-cash')).toBe('Order-to-Cash');
    expect(titleCase('esg reporting')).toBe('ESG Reporting');
  });
});

describe('TF-IDF', () => {
  const corpus = buildCorpus([{ text: 'invoice approval' }, { text: 'invoice payments' }, { text: 'bank reconciliation' }]);
  // idf = ln((1 + N) / (1 + df)) + 1 with N = 3
  const sharedIdf = Math.log(4 / 3) + 1; // "invoice": df 2
  const uniqueIdf = Math.log(4 / 2) + 1; // every other term: df 1

  it('weights terms by tf * idf and scales each vector to length 1', () => {
    const length = Math.sqrt(sharedIdf ** 2 + 2 * uniqueIdf ** 2); // invoice, approval, "invoice approval"
    const first = corpus.vectors[0]!;
    expect(first.get('invoice')).toBeCloseTo(sharedIdf / length, 10);
    expect(first.get('approval')).toBeCloseTo(uniqueIdf / length, 10);
    expect(first.get('invoice approval')).toBeCloseTo(uniqueIdf / length, 10);
    expect(norm(first)).toBeCloseTo(1, 10);
  });

  it('counts document frequency and remembers how terms were written', () => {
    expect(corpus.documentFrequency.get('invoice')).toBe(2);
    expect(corpus.surface.get('payment')).toBe('payments');
  });

  it('cosine is 1 for the same direction, 0 for no shared terms, and the normalized dot product otherwise', () => {
    const [approval, payments, bank] = corpus.vectors as [Map<string, number>, Map<string, number>, Map<string, number>];
    expect(cosine(approval, approval)).toBeCloseTo(1, 10);
    expect(cosine(approval, bank)).toBe(0);
    expect(cosine(approval, payments)).toBeCloseTo(sharedIdf ** 2 / (sharedIdf ** 2 + 2 * uniqueIdf ** 2), 10);
    expect(cosine(new Map([['a', 3], ['b', 4]]), new Map([['a', 6], ['b', 8]]))).toBeCloseTo(1, 10);
    expect(cosine(new Map(), approval)).toBe(0);
  });

  it('normalizes and averages sparse vectors', () => {
    expect(normalize(new Map([['a', 3], ['b', 4]]))).toEqual(new Map([['a', 0.6], ['b', 0.8]]));
    expect(mean([new Map([['a', 1]]), new Map([['a', 3], ['b', 2]])])).toEqual(new Map([['a', 2], ['b', 1]]));
  });

  it('adds taxonomy tags at half weight under a # key', () => {
    const tagged = buildCorpus([{ text: '', tags: ['Software'] }, { text: '', tags: ['Software', 'saas'] }]);
    expect(tagged.documentFrequency.get('#software')).toBe(2);
    expect(TAG_WEIGHT).toBe(0.5);
    expect(tagged.vectors[0]).toEqual(new Map([['#software', 1]]));
  });

  it('can drop terms that appear in fewer than N documents', () => {
    const pruned = buildCorpus([{ text: 'invoice approval' }, { text: 'invoice payments' }], { minDocumentFrequency: 2 });
    expect([...pruned.vectors[0]!.keys()]).toEqual(['invoice']);
  });

  it('vectorizes new text in the same term space, dropping unseen terms', () => {
    const hint = corpus.vectorize('invoice approval and tax filing');
    expect([...hint.keys()].sort()).toEqual(['approval', 'invoice', 'invoice approval']);
  });
});
