import type { Company } from '@companyenrich/sdk';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeDomain, parseDomains } from '../src/lib/domains.ts';
import { readEnrichCache } from '../src/lib/enrich-cache.ts';
import { buildEvalSet, enrichWithCache, planGenerate, uncachedDomains } from '../src/lib/generate.ts';
import { buildQuestions, fundingStageOptions, topLevelIndustries, type QuestionContext } from '../src/lib/questions.ts';
import { fakeCompanyEnrich, jsonResponse } from './fakes.ts';
import { industries, placeholderCo, stripe, tinyCo } from './fixtures.ts';

const context: QuestionContext = {
  retrievedAt: '2026-11-11',
  industries: ['Finance', 'Media & Internet', 'Energy, Utilities & Waste'],
  fundingStages: ['seed', 'series_a', 'secondary_market'],
};

describe('buildQuestions', () => {
  it('asks one question per field when every gold value is present', () => {
    const questions = buildQuestions(stripe, context);
    expect(questions.map((q) => q.field)).toEqual([
      'employees',
      'revenue',
      'foundedYear',
      'hqCountry',
      'hqCity',
      'industry',
      'fundingStage',
      'totalFunding',
      'categories',
    ]);
  });

  it('stores gold, field path, answer type and retrieval date', () => {
    const byField = new Map(buildQuestions(stripe, context).map((q) => [q.field, q]));
    expect(byField.get('hqCountry')).toMatchObject({
      id: 'stripe.com#hqCountry',
      gold: 'US',
      fieldPath: 'location.country.code',
      answerType: 'country',
      retrievedAt: '2026-11-11',
      sourceUpdatedAt: stripe.updatedAt,
    });
    expect(byField.get('totalFunding')).toMatchObject({ gold: 8805247725, answerType: 'money' });
    expect(byField.get('categories')?.gold).toEqual(['b2b', 'service-provider']);
    expect(byField.get('employees')?.options).toContain('over-10K');
  });

  it('names the company and its domain in the question and lists the options', () => {
    const industry = buildQuestions(stripe, context).find((q) => q.field === 'industry')!;
    expect(industry.question).toBe(
      'What is the primary industry of Stripe (stripe.com)? Answer with exactly one of: Finance; Media & Internet; Energy, Utilities & Waste.',
    );
  });

  it('skips questions whose gold value is missing', () => {
    const fields = buildQuestions(tinyCo, context).map((q) => q.field);
    expect(fields).toEqual(['employees', 'foundedYear', 'hqCountry', 'industry', 'categories']);
  });

  it('skips placeholder funding amounts and stages that mean "unknown"', () => {
    const fields = buildQuestions(placeholderCo, context).map((q) => q.field);
    expect(fields).not.toContain('totalFunding');
    expect(fields).not.toContain('fundingStage');
    expect(fields).toContain('hqCity');
  });
});

describe('option lists', () => {
  it('adds stages seen in the records after the standard ones, without placeholder stages', () => {
    const options = fundingStageOptions([stripe, placeholderCo, tinyCo]);
    expect(options[0]).toBe('angel');
    expect(options.at(-1)).toBe('secondary_market');
    expect(options).not.toContain('undisclosed');
  });

  it('keeps only top-level industries', () => {
    expect(topLevelIndustries(industries.map((i) => i.name))).toEqual([
      'Energy, Utilities & Waste',
      'Finance',
      'Media & Internet',
      'Software',
    ]);
  });
});

describe('domains', () => {
  it('normalizes scheme, www, case and path', () => {
    expect(normalizeDomain(' https://www.Stripe.com/pricing ')).toBe('stripe.com');
  });

  it('parses a domains file, dropping comments, blanks and duplicates', () => {
    expect(parseDomains('# list\nstripe.com\n\nwww.stripe.com\nposthog.com # small\n')).toEqual([
      'stripe.com',
      'posthog.com',
    ]);
  });
});

describe('enrichWithCache', () => {
  const records: Record<string, Company> = {
    'stripe.com': stripe,
    'stripe-alias.example': stripe,
    'tinyanalytics.example': tinyCo,
    'placeholder.example': placeholderCo,
  };

  /** Answers each batch from `records`; `failOnCall` makes that call (1-based) return a 500. */
  function fake(failOnCall?: number) {
    let calls = 0;
    return fakeCompanyEnrich({
      'POST /v2/companies/enrich/batch': (request) => {
        calls += 1;
        if (calls === failOnCall) return jsonResponse({ title: 'Server error' }, 500);
        return jsonResponse({
          items: (request.body.domains as string[]).map((domain) =>
            records[domain]
              ? { domain, status: 'found', company: records[domain] }
              : { domain, status: domain.startsWith('pending') ? 'pending' : 'not-found' },
          ),
        });
      },
    });
  }

  const tempCache = async () => join(await mkdtemp(join(tmpdir(), 'ahe-')), 'eval.enrich.jsonl');
  const fillers = (n: number) => Array.from({ length: n }, (_, i) => `none-${i}.example`);

  it('enriches with the financial expansion, charges 2 credits per company found and saves every result', async () => {
    const { client, requests } = fake();
    const cachePath = await tempCache();
    const ledger = { creditsSpent: 0 };
    const entries = await enrichWithCache(client, ['stripe.com', 'nothing.example'], cachePath, '2026-11-11', ledger);

    expect(requests[0]?.body).toEqual({ domains: ['stripe.com', 'nothing.example'], expand: ['financial'] });
    expect(entries.map((e) => [e.domain, e.status])).toEqual([
      ['stripe.com', 'found'],
      ['nothing.example', 'not-found'],
    ]);
    expect(ledger.creditsSpent).toBe(2);
    expect([...(await readEnrichCache(cachePath)).keys()]).toEqual(['stripe.com', 'nothing.example']);
  });

  it('keeps a paid batch when a later batch fails, then resumes without buying it again', async () => {
    const cachePath = await tempCache();
    const domains = ['stripe.com', ...fillers(48), 'tinyanalytics.example', 'placeholder.example', 'nothing.example'];

    const failing = fake(2);
    const ledger = { creditsSpent: 0 };
    await expect(enrichWithCache(failing.client, domains, cachePath, '2026-11-11', ledger)).rejects.toThrow();
    expect(failing.requests).toHaveLength(2);
    expect(ledger.creditsSpent).toBe(4);
    expect((await readEnrichCache(cachePath)).size).toBe(50);
    expect(await uncachedDomains(domains, cachePath)).toEqual(['placeholder.example', 'nothing.example']);

    const working = fake();
    const resumed = { creditsSpent: 0 };
    const entries = await enrichWithCache(working.client, domains, cachePath, '2026-11-12', resumed);
    expect(working.requests).toHaveLength(1);
    expect(working.requests[0]?.body.domains).toEqual(['placeholder.example', 'nothing.example']);
    expect(resumed.creditsSpent).toBe(2);
    expect(entries.filter((e) => e.status === 'found').map((e) => [e.domain, e.fetchedAt])).toEqual([
      ['stripe.com', '2026-11-11'],
      ['tinyanalytics.example', '2026-11-11'],
      ['placeholder.example', '2026-11-12'],
    ]);
  });

  it('sums each batch charge, so a company found again in a later batch is counted again', async () => {
    const { client } = fake();
    const sameBatch = { creditsSpent: 0 };
    await enrichWithCache(client, ['stripe.com', 'stripe-alias.example'], await tempCache(), '2026-11-11', sameBatch);
    expect(sameBatch.creditsSpent).toBe(2);

    const twoBatches = { creditsSpent: 0 };
    const domains = ['stripe.com', ...fillers(49), 'stripe-alias.example'];
    await enrichWithCache(client, domains, await tempCache(), '2026-11-11', twoBatches);
    expect(twoBatches.creditsSpent).toBe(4);
  });

  it('does not save pending results, so the next run asks again', async () => {
    const cachePath = await tempCache();
    const entries = await enrichWithCache(fake().client, ['pending.example'], cachePath, '2026-11-11', { creditsSpent: 0 });
    expect(entries).toEqual([{ domain: 'pending.example', status: 'pending', fetchedAt: '2026-11-11' }]);
    expect(await uncachedDomains(['pending.example'], cachePath)).toEqual(['pending.example']);
  });

  it('ignores saved lines whose key is not a normalized domain or that lack their company', async () => {
    const cachePath = await tempCache();
    await writeFile(
      cachePath,
      [
        { domain: 'https://www.stripe.com', status: 'found', company: stripe, fetchedAt: '2026-11-11' },
        { domain: 'tinyanalytics.example', status: 'found', fetchedAt: '2026-11-11' },
        { domain: 'nothing.example', status: 'not-found', fetchedAt: '2026-11-11' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    expect([...(await readEnrichCache(cachePath)).keys()]).toEqual(['nothing.example']);
  });
});

describe('buildEvalSet', () => {
  it('asks about each company once, dated by when its record was fetched, with industries from the free list', async () => {
    const { client } = fakeCompanyEnrich({ 'GET /v2/industries': () => jsonResponse({ items: industries }) });
    const questions = await buildEvalSet(client, [
      { domain: 'stripe.com', status: 'found', company: stripe, fetchedAt: '2026-11-10' },
      { domain: 'stripe-alias.example', status: 'found', company: stripe, fetchedAt: '2026-11-11' },
      { domain: 'tinyanalytics.example', status: 'found', company: tinyCo, fetchedAt: '2026-11-11' },
      { domain: 'nothing.example', status: 'not-found', fetchedAt: '2026-11-11' },
    ]);
    expect(questions).toHaveLength(9 + 5);
    expect(questions[0]?.retrievedAt).toBe('2026-11-10');
    expect(questions.find((q) => q.field === 'industry')?.options).toEqual([
      'Energy, Utilities & Waste',
      'Finance',
      'Media & Internet',
      'Software',
    ]);
  });
});

describe('planGenerate', () => {
  it('plans a dry run with free calls only', async () => {
    const { client, requests } = fakeCompanyEnrich({
      'GET /v2/companies/autocomplete': (request) =>
        jsonResponse({
          items: request.query.get('query') === 'stripe.com' ? [{ id: stripe.id, domain: 'stripe.com', logoUrl: '' }] : [],
        }),
      'GET /v2/me': () => jsonResponse({ userId: 'u', credits: { used: 10, total: 100 }, capabilities: {} }),
    });
    const plan = await planGenerate(client, ['stripe.com', 'unknown.example']);
    expect(plan).toEqual({
      domains: ['stripe.com', 'unknown.example'],
      estimatedCredits: 4,
      unknownDomains: ['unknown.example'],
      creditsRemaining: 90,
    });
    expect(requests.map((r) => r.path).sort()).toEqual([
      '/v2/companies/autocomplete',
      '/v2/companies/autocomplete',
      '/v2/me',
    ]);
  });
});
