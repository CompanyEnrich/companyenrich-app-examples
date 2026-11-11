import { describe, expect, it } from 'vitest';
import { type NewCompaniesConfig, parseConfig } from '../src/lib/config.js';
import type { NewCompaniesState } from '../src/lib/state.js';
import { NOT_IN_LIMIT, excludeSeenDomains, planNewCompanies } from '../src/lib/watchers/new-companies.js';
import { createFakeApi, fakeCompany, ignoreProgress } from './helpers/fake-api.js';

const NOW = new Date('2026-11-11T08:00:00Z');

function companiesWatcher(query = '      filter: { country: US }', extra = ''): NewCompaniesConfig {
  return parseConfig(`
watchers:
  - id: funded
    type: new-companies
    maxResultsPerRun: 3
${extra}
    query:
${query}
`).watchers[0] as NewCompaniesConfig;
}

describe('excludeSeenDomains', () => {
  it('leaves the filter alone before anything has been seen', () => {
    expect(excludeSeenDomains({ country: 'US' }, [])).toEqual({ country: 'US' });
    expect(excludeSeenDomains(undefined, [])).toBeUndefined();
  });

  it('adds seen domains to notIn and keeps configured domain rules', () => {
    expect(excludeSeenDomains({ country: 'US' }, ['a.com'])).toEqual({ country: 'US', domain: { notIn: ['a.com'] } });
    expect(excludeSeenDomains({ domain: { notIn: ['customer.com'] } }, ['a.com'])).toEqual({
      domain: { notIn: ['customer.com', 'a.com'] },
    });
    expect(excludeSeenDomains({ domain: ['x.com', 'y.com'] }, ['x.com'])).toEqual({
      domain: { in: ['x.com', 'y.com'], notIn: ['x.com'] },
    });
  });

  it(`sends only the ${NOT_IN_LIMIT} most recent domains`, () => {
    const seen = Array.from({ length: NOT_IN_LIMIT + 10 }, (_, index) => `d${index}.com`);
    const rule = excludeSeenDomains({ domain: { notIn: ['customer.com'] } }, seen)?.domain as { notIn: string[] };
    expect(rule.notIn).toHaveLength(NOT_IN_LIMIT);
    expect(rule.notIn[0]).toBe('customer.com');
    expect(rule.notIn[1]).toBe('d11.com');
    expect(rule.notIn.at(-1)).toBe(`d${NOT_IN_LIMIT + 9}.com`);
  });
});

describe('new-companies watcher', () => {
  it('skips the paid search when the free count is 0', async () => {
    const api = createFakeApi({ 'POST /v2/companies/search/count': () => ({ count: 0, total: 0 }) });
    const plan = await planNewCompanies({ client: api.client, now: NOW }, companiesWatcher(), undefined);
    expect(plan.units).toBe(0);
    expect(plan.finding).toBe('no new matches');

    const run = await plan.execute(0, ignoreProgress);
    expect(run.creditsCharged).toBe(0);
    expect(api.paidCalls()).toHaveLength(0);
    expect(run.nextState).toEqual({ type: 'new-companies', lastRunAt: NOW.toISOString(), seenDomains: [] });
  });

  it('fetches up to maxResultsPerRun, records them, and carries the rest', async () => {
    const api = createFakeApi({
      'POST /v2/companies/search/count': () => ({ count: 7, total: 7 }),
      'POST /v2/companies/search': (body) => ({
        items: ['a.com', 'b.com', 'c.com'].slice(0, body.pageSize).map((domain) => fakeCompany(domain)),
      }),
    });
    const previous: NewCompaniesState = { type: 'new-companies', lastRunAt: '2026-11-04T00:00:00Z', seenDomains: ['old.com'] };
    const plan = await planNewCompanies({ client: api.client, now: NOW }, companiesWatcher(), previous);
    expect(plan).toMatchObject({ units: 3, unitCost: 1, finding: '7 new matches' });
    expect(api.callsTo('POST /v2/companies/search/count')[0]?.body).toEqual({
      filter: { country: 'US', domain: { notIn: ['old.com'] } },
    });

    const run = await plan.execute(3, ignoreProgress);
    expect(api.callsTo('POST /v2/companies/search')[0]?.body).toMatchObject({ pageSize: 3 });
    expect(run.signals.map((signal) => signal.domain)).toEqual(['a.com', 'b.com', 'c.com']);
    expect(run.notes).toContain('4 more matches will be picked up on later runs.');
    expect(run.creditsCharged).toBe(3);
    expect((run.nextState as NewCompaniesState).seenDomains).toEqual(['old.com', 'a.com', 'b.com', 'c.com']);
  });

  it('drops companies seen before but older than the notIn window', async () => {
    const api = createFakeApi({
      'POST /v2/companies/search/count': () => ({ count: 2, total: 2 }),
      'POST /v2/companies/search': () => ({ items: [fakeCompany('old.com'), fakeCompany('new.com')] }),
    });
    const previous: NewCompaniesState = { type: 'new-companies', lastRunAt: '2026-11-04T00:00:00Z', seenDomains: ['old.com'] };
    const plan = await planNewCompanies({ client: api.client, now: NOW }, companiesWatcher(), previous);
    const run = await plan.execute(2, ignoreProgress);
    expect(run.signals.map((signal) => signal.domain)).toEqual(['new.com']);
    expect(run.notes).toContain('Skipped 1 company already reported.');
  });

  it('prices semantic queries and expansions, and shows funding in the signal', async () => {
    const api = createFakeApi({
      'POST /v2/companies/search/count': () => ({ count: 1, total: 1 }),
      'POST /v2/companies/search': () => ({
        items: [
          fakeCompany('acme.com', {
            name: 'Acme',
            employees: '51-200',
            financial: { fundingStage: 'series_a', fundingDate: '2026-03-02T00:00:00Z', totalFunding: 12_500_000 },
          }),
        ],
      }),
    });
    const watcher = companiesWatcher('      semantic: { query: data tools }', '    expand: [financial]');
    const plan = await planNewCompanies({ client: api.client, now: NOW }, watcher, undefined);
    expect(plan.unitCost).toBe(3);

    const run = await plan.execute(1, ignoreProgress);
    expect(api.callsTo('POST /v2/companies/search')[0]?.body).toEqual({
      semantic: { query: 'data tools' },
      pageSize: 1,
      expand: ['financial'],
    });
    expect(run.signals[0]).toEqual({
      title: 'Acme',
      domain: 'acme.com',
      summary: 'Series A on 2026-03-02 · $12.5M raised in total · Software · 51-200 employees · San Francisco, US',
      details: [],
      link: { label: 'acme.com', url: 'https://acme.com' },
    });
    expect(run.creditsCharged).toBe(3);
  });
});
