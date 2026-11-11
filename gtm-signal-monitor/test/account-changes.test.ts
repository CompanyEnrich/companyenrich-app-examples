import type { Company } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { type AccountChangesConfig, parseConfig } from '../src/lib/config.js';
import type { AccountChangesState } from '../src/lib/state.js';
import { planAccountChanges } from '../src/lib/watchers/account-changes.js';
import { createFakeApi, fakeCompany, ignoreProgress } from './helpers/fake-api.js';

const FIRST_RUN = new Date('2026-11-11T08:00:00Z');

function accountsWatcher(domains = '[stripe.com, notion.so]'): AccountChangesConfig {
  return parseConfig(`
watchers:
  - id: accounts
    type: account-changes
    domains: ${domains}
`).watchers[0] as AccountChangesConfig;
}

function batchApi(companies: Record<string, Company | undefined>) {
  return createFakeApi({
    'POST /v2/companies/enrich/batch': (body) => ({
      items: body.domains.map((domain: string) =>
        companies[domain] ? { domain, status: 'found', company: companies[domain] } : { domain, status: 'not-found' },
      ),
    }),
  });
}

const stripe = (overrides: Partial<Company> = {}) =>
  fakeCompany('stripe.com', {
    name: 'Stripe',
    technologies: ['React'],
    financial: { fundingStage: 'series_i', fundingDate: '2023-03-15T00:00:00Z', totalFunding: 9_000_000_000 },
    workforce: {
      companyId: 'id-stripe.com',
      domain: 'stripe.com',
      observedEmployeeCount: 1000,
      departmentHeadcount: { engineeringTechnical: 300, sales: 100 },
      unclassifiedHeadcount: 0,
      historyFrom: '2025-11-01',
      historyTo: '2026-11-01',
    },
    ...overrides,
  });

describe('account-changes watcher', () => {
  it('records a baseline on the first run and reports no changes', async () => {
    const api = batchApi({ 'stripe.com': stripe(), 'notion.so': fakeCompany('notion.so') });
    const plan = await planAccountChanges({ client: api.client, now: FIRST_RUN }, accountsWatcher(), undefined);
    expect(plan).toMatchObject({ units: 2, unitCost: 4, finding: '2 of 2 accounts due for a refresh' });

    const run = await plan.execute(2, ignoreProgress);
    expect(api.callsTo('POST /v2/companies/enrich/batch')[0]?.body).toEqual({
      domains: ['stripe.com', 'notion.so'],
      expand: ['financial', 'technologies', 'workforce'],
    });
    expect(run.signals).toEqual([]);
    expect(run.notes).toEqual(['Baseline recorded for 2 accounts. Changes show up from the next refresh.']);
    expect(run.creditsCharged).toBe(8);
    const state = run.nextState as AccountChangesState;
    expect(Object.keys(state.snapshots)).toEqual(['stripe.com', 'notion.so']);
    expect(state.snapshots['stripe.com']?.workforce).toEqual({ observed: 1000, departments: { engineeringTechnical: 300, sales: 100 } });
  });

  it('does not re-enrich accounts refreshed less than refreshEveryDays ago', async () => {
    const api = batchApi({ 'stripe.com': stripe(), 'notion.so': fakeCompany('notion.so') });
    const first = await planAccountChanges({ client: api.client, now: FIRST_RUN }, accountsWatcher(), undefined);
    const firstRun = await first.execute(2, ignoreProgress);

    const soon = new Date('2026-11-12T08:00:00Z');
    const second = await planAccountChanges({ client: api.client, now: soon }, accountsWatcher(), firstRun.nextState as AccountChangesState);
    expect(second.units).toBe(0);
    expect(second.finding).toBe('all 2 accounts are fresh; next refresh 2026-11-18');
    const secondRun = await second.execute(0, ignoreProgress);
    expect(secondRun.creditsCharged).toBe(0);
    expect(api.paidCalls()).toHaveLength(1);
  });

  it('reports changes after the refresh interval', async () => {
    const companies: Record<string, Company> = { 'stripe.com': stripe(), 'notion.so': fakeCompany('notion.so') };
    const api = batchApi(companies);
    const first = await planAccountChanges({ client: api.client, now: FIRST_RUN }, accountsWatcher(), undefined);
    const firstRun = await first.execute(2, ignoreProgress);

    companies['stripe.com'] = stripe({ employees: '5K-10K', technologies: ['React', 'Snowflake'] });
    const nextWeek = new Date('2026-11-18T08:00:00Z');
    const second = await planAccountChanges({ client: api.client, now: nextWeek }, accountsWatcher(), firstRun.nextState as AccountChangesState);
    const run = await second.execute(second.units, ignoreProgress);

    expect(run.signals).toEqual([
      {
        title: 'Stripe',
        domain: 'stripe.com',
        summary: '2 changes since 2026-11-11',
        details: ['Employees: 201-500 → 5K-10K', 'Technologies added: Snowflake'],
        link: { label: 'stripe.com', url: 'https://stripe.com' },
      },
    ]);
    expect(run.notes).toEqual(['1 account refreshed with no changes.']);
  });

  it('charges only for companies found and retries the rest next run', async () => {
    const api = batchApi({ 'stripe.com': stripe() });
    const plan = await planAccountChanges({ client: api.client, now: FIRST_RUN }, accountsWatcher('[stripe.com, unknown-co.io]'), undefined);
    const run = await plan.execute(2, ignoreProgress);
    expect(run.creditsCharged).toBe(4);
    expect(run.notes).toContain('No company data for unknown-co.io (not-found); retried next run.');
    expect(Object.keys((run.nextState as AccountChangesState).snapshots)).toEqual(['stripe.com']);
  });

  it('splits large lists into batches of 50 and carries accounts past the grant', async () => {
    const domains = Array.from({ length: 60 }, (_, index) => `co${index}.com`);
    const api = batchApi(Object.fromEntries(domains.map((domain) => [domain, fakeCompany(domain)])));
    const plan = await planAccountChanges({ client: api.client, now: FIRST_RUN }, accountsWatcher(`[${domains.join(', ')}]`), undefined);
    const run = await plan.execute(55, ignoreProgress);
    expect(api.callsTo('POST /v2/companies/enrich/batch').map((call) => call.body.domains.length)).toEqual([50, 5]);
    expect(run.notes).toContain('5 accounts carried to the next run by the credit cap.');
  });
});
