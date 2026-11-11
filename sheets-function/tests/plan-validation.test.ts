import { describe, expect, it } from 'vitest';
import { FakeSheet, FakeSpreadsheet } from '../harness/fakes.js';
import { confirm, setup } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);

function withSheet(rows: unknown[][], select: string) {
  const spreadsheet = new FakeSpreadsheet([new FakeSheet('Accounts', rows)]);
  const environment = setup({ spreadsheet });
  spreadsheet.select('Accounts', select);
  return environment;
}

describe('runLookalikes does not trust the plan from the browser', () => {
  it('refuses a plan that was not confirmed', () => {
    const { script, urlFetch } = withSheet([['acme.example']], 'A1');
    const plan = script.estimateLookalikes({ results: 2 });
    expect(() => script.runLookalikes(plan)).toThrow('Confirm the estimate in the sidebar before running it.');
    expect(() => script.runLookalikes({ ...plan, confirmed: 'yes' })).toThrow('Confirm the estimate');
    expect(urlFetch.to('/companies/search')).toHaveLength(0);
  });

  it('rebuilds the query itself, so injected expansions are never sent or billed', () => {
    const { script, urlFetch, documentProperties } = withSheet([['acme.example']], 'A1');
    const plan = script.estimateLookalikes({ results: 2 });
    const tampered = {
      ...confirm(plan),
      query: {
        lookalike: { domains: ['acme.example'] },
        expand: ['financial', 'keywords', 'naicsCodes', 'technologies', 'workforce'],
      },
      expand: ['technologies'],
    };
    const result = script.runLookalikes(tampered);
    expect(urlFetch.to('/companies/search')[0]?.body).toEqual({
      lookalike: { domains: ['acme.example'] },
      filter: { domain: { notIn: ['acme.example'] } },
      pageSize: 2,
    });
    expect(result.credits).toBe(10);
    expect(documentProperties.getProperty(`ce:spent:${today}`)).toBe('10');
  });

  it.each([
    ['results above the limit', { results: 1000 }, 'Number of lookalikes must be a whole number from 1 to 25.'],
    ['results that are not a number', { results: '2; drop' }, 'Number of lookalikes must be a whole number'],
    ['a missing confirmed amount', { maxCredits: undefined }, 'more than the undefined you confirmed'],
    ['a confirmed amount below the real cost', { maxCredits: 9 }, 'This would cost 10 credits, more than the 9 you confirmed'],
    ['an invalid domain', { domain: 'not a domain' }, 'The plan has no valid domain.'],
    ['invalid country codes', { countries: ['us', 'XYZ'] }, 'The plan has invalid country codes.'],
  ])('refuses %s', (_, change, message) => {
    const { script, urlFetch } = withSheet([['acme.example']], 'A1');
    const plan = confirm(script.estimateLookalikes({ results: 2 }));
    expect(() => script.runLookalikes({ ...plan, ...change })).toThrow(message);
    expect(urlFetch.to('/companies/search')).toHaveLength(0);
  });
});

describe('runPeople does not trust the plan from the browser', () => {
  const rows = [['acme.example'], ['globex.example']];

  it('refuses a plan that was not confirmed', () => {
    const { script, urlFetch } = withSheet(rows, 'A1:A2');
    expect(() => script.runPeople(script.estimatePeople({ perCompany: 1 }))).toThrow('Confirm the estimate');
    expect(urlFetch.to('/people/search')).toHaveLength(0);
  });

  it('builds the filter from validated options and ignores anything else in the plan', () => {
    const { script, urlFetch } = withSheet(rows, 'A1:A2');
    const plan = confirm(script.estimatePeople({ seniorities: ['vp'], perCompany: 1 }));
    script.runPeople({ ...plan, filter: { seniority: 'intern' }, expand: ['education', 'company'] });
    expect(urlFetch.to('/people/search').map((request) => request.body)).toEqual([
      { filter: { seniority: ['vp'], domain: 'acme.example' }, pageSize: 1 },
      { filter: { seniority: ['vp'], domain: 'globex.example' }, pageSize: 1 },
    ]);
  });

  it.each([
    ['more people per company than chosen', () => ({ companies: [{ domain: 'acme.example', take: 5 }] }), 'People per company must be a whole number from 0 to 1.'],
    ['too many companies', () => ({ companies: Array.from({ length: 26 }, (_, i) => ({ domain: `c${i}.example`, take: 1 })) }), 'at most 25 companies'],
    ['a repeated domain', () => ({ companies: [{ domain: 'acme.example', take: 1 }, { domain: 'ACME.example', take: 1 }] }), 'invalid or repeated domain'],
    ['an unknown seniority', (plan: any) => ({ options: { ...plan.options, seniorities: ['boss'] } }), 'Unknown seniority "boss"'],
    ['too many title keywords', (plan: any) => ({ options: { ...plan.options, titles: Array(11).fill('sales') } }), 'at most 10 title keywords'],
    ['a confirmed amount below the real cost', () => ({ maxCredits: 3 }), 'This would cost 4 credits, more than the 3 you confirmed'],
  ])('refuses %s', (_, change, message) => {
    const { script, urlFetch } = withSheet(rows, 'A1:A2');
    const plan = confirm(script.estimatePeople({ perCompany: 1 }));
    expect(() => script.runPeople({ ...plan, ...change(plan) })).toThrow(message);
    expect(urlFetch.to('/people/search')).toHaveLength(0);
  });
});

describe('enrichSelectionChunk does not trust the job from the browser', () => {
  it.each([
    ['an unconfirmed job', { confirmed: false }, 'Confirm the estimate'],
    ['a paid-expansion field', { fields: ['technologies'] }, 'only returned with a paid expansion'],
    ['no fields', { fields: [] }, 'Pick at least one field.'],
    ['a negative row count', { rowCount: -1 }, 'Row count must be a whole number'],
    ['progress past the end', { offset: 99 }, 'Progress must be a whole number from 0 to 2.'],
    ['column 0', { column: 0 }, 'Column must be a whole number from 1'],
    ['a fractional confirmed amount', { maxCredits: 1.5 }, 'Confirmed credits must be a whole number'],
  ])('refuses %s', (_, change, message) => {
    const { script, urlFetch, spreadsheet } = withSheet([['acme.example'], ['globex.example']], 'A1:A2');
    const job = confirm(script.estimateEnrichSelection(['name']));
    expect(() => script.enrichSelectionChunk({ ...job, ...change })).toThrow(message);
    expect(urlFetch.to('/companies/enrich/batch')).toHaveLength(0);
    expect(spreadsheet.getSheetByName('Accounts')?.values()).toEqual([['acme.example'], ['globex.example']]);
  });
});
