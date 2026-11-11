import { ServerError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { CreditLedger } from '../src/lib/credits.js';
import { buildTargetFilter } from '../src/lib/filters.js';
import { countCompanies } from '../src/lib/sizing.js';
import { allocateAccounts, estimateAccounts, fillAccounts, sizeTiers, tierFilters, type TierSizes } from '../src/lib/tiers.js';
import type { Account } from '../src/lib/types.js';
import { fakeApi, NOW } from './fake-api.js';

const target = buildTargetFilter({ competitor: 'zendesk', mine: 'intercom', countries: [], employees: [], categories: [], exclude: [] });
const silent = () => undefined;

describe('tier construction', () => {
  it('tier 1 is growing and recently funded, tier 2 growing, tier 3 the whole target filter', () => {
    const filters = tierFilters(target, NOW);
    expect(filters[1]).toEqual({
      ...target,
      workforceGrowth: { period: 'm6', department: 'overall', min: 0.1 },
      fundingYear: { min: 2025 },
      fundingAmount: { min: 1_000_000 },
    });
    expect(filters[2]).toEqual({ ...target, workforceGrowth: { period: 'm6', department: 'overall', min: 0.1 } });
    expect(filters[3]).toEqual(target);
  });

  it('sizes disjoint tiers from free counts', async () => {
    const api = fakeApi();
    const sizes = await sizeTiers(api.client, target, 7, NOW);
    expect(sizes).toEqual({ 1: 2, 2: 2, 3: 3, growing: 4, funded: 3 });
    expect(api.paidCalls()).toHaveLength(0);
  });

  it('allocates accounts to tier 1 first, then 2, then 3', () => {
    const sizes: TierSizes = { 1: 2, 2: 3, 3: 100, growing: 5, funded: 9 };
    expect(allocateAccounts(10, sizes)).toEqual({ 1: 2, 2: 3, 3: 5 });
    expect(allocateAccounts(1, sizes)).toEqual({ 1: 1, 2: 0, 3: 0 });
    expect(allocateAccounts(200, sizes)).toEqual({ 1: 2, 2: 3, 3: 100 });
  });

  it('prices accounts at 1 credit, or 2 with the financial expansion', () => {
    const sizes: TierSizes = { 1: 2, 2: 3, 3: 100, growing: 5, funded: 9 };
    expect(estimateAccounts({ accounts: 10, sizes, withFunding: false }).credits).toBe(10);
    expect(estimateAccounts({ accounts: 10, sizes, withFunding: true }).credits).toBe(20);
  });
});

describe('fillAccounts', () => {
  async function fill(accounts: number, options: Parameters<typeof fakeApi>[0] = {}, withFunding = false) {
    const api = fakeApi(options);
    const [targets = 0] = await countCompanies(api.client, [target]);
    const sizes = await sizeTiers(api.client, target, targets, NOW);
    const ledger = new CreditLedger(100);
    const result: Account[] = [];
    const error = await fillAccounts(api.client, { filters: tierFilters(target, NOW), sizes, accounts, withFunding, now: NOW }, ledger, silent, result).catch(
      (e: unknown) => e,
    );
    return { api, ledger, result, error, searches: api.callsTo('/v2/companies/search') };
  }

  it('fills from tier 1, then tier 2, then tier 3, excluding domains already fetched', async () => {
    const { result, searches } = await fill(5);

    expect(result.map((a) => [a.rank, a.tier, a.company.domain])).toEqual([
      [1, 1, 'alpha.example'],
      [2, 1, 'bravo.example'],
      [3, 2, 'charlie.example'],
      [4, 2, 'delta.example'],
      [5, 3, 'echo.example'],
    ]);
    expect(searches.map((call) => call.body?.pageSize)).toEqual([2, 2, 1]);
    expect(searches[0]?.body?.filter.domain).toBeUndefined();
    expect(searches[1]?.body?.filter.domain).toEqual({ notIn: ['alpha.example', 'bravo.example'] });
    expect(searches[2]?.body?.filter.domain).toEqual({ notIn: ['alpha.example', 'bravo.example', 'charlie.example', 'delta.example'] });
  });

  it('records the signals each account was selected for', async () => {
    const { result } = await fill(5);
    expect(result[0]?.signals).toEqual(['headcount +10% or more in 6 months', 'latest round in 2025 or later, $1M+ raised']);
    expect(result[2]?.signals).toEqual(['headcount +10% or more in 6 months']);
    expect(result[4]?.signals).toEqual([]);
  });

  it('stops after the tier that fills the request, and never calls for an empty tier', async () => {
    const { searches } = await fill(2);
    expect(searches).toHaveLength(1);

    const noTier1 = await fill(3, { companies: [{ domain: 'solo.example', technologies: ['zendesk'], country: 'US', employees: '1-10', growing: true }] });
    expect(noTier1.searches).toHaveLength(1); // tier 1 and tier 3 are empty, only tier 2 is searched
    expect(noTier1.result.map((a) => a.tier)).toEqual([2]);
  });

  it('bills what the API charged, and never more than the estimate when counts were stale', async () => {
    const { api, ledger, result } = await fill(5, { searchLimit: 1 }, true);
    expect(result).toHaveLength(3); // one per tier
    expect(ledger.spent).toBe(api.charged());
    expect(ledger.spent).toBeLessThanOrEqual(10);
    expect(api.callsTo('/v2/companies/search')[0]?.body?.expand).toEqual(['financial']);
  });

  it('keeps the pages already paid for when a later tier search fails', async () => {
    const { api, ledger, result, error } = await fill(5, { fail: (call, nth) => (call.path === '/v2/companies/search' && nth === 1 ? 500 : undefined) });
    expect(error).toBeInstanceOf(ServerError);
    expect(result.map((a) => a.company.domain)).toEqual(['alpha.example', 'bravo.example']);
    expect(ledger.spent).toBe(2);
    expect(ledger.spent).toBe(api.charged());
  });

  it('merges already-fetched domains into an existing --exclude rule', async () => {
    const excluded = buildTargetFilter({ competitor: 'zendesk', mine: 'intercom', countries: [], employees: [], categories: [], exclude: ['alpha.example'] });
    const api = fakeApi();
    const [targets = 0] = await countCompanies(api.client, [excluded]);
    const sizes = await sizeTiers(api.client, excluded, targets, NOW);
    expect(sizes).toMatchObject({ 1: 1, 2: 2, 3: 3 });

    const result: Account[] = [];
    await fillAccounts(api.client, { filters: tierFilters(excluded, NOW), sizes, accounts: 3, withFunding: false, now: NOW }, new CreditLedger(100), silent, result);
    expect(result.map((a) => a.company.domain)).toEqual(['bravo.example', 'charlie.example', 'delta.example']);
    expect(api.callsTo('/v2/companies/search')[1]?.body?.filter.domain).toEqual({ notIn: ['alpha.example', 'bravo.example'] });
  });
});
